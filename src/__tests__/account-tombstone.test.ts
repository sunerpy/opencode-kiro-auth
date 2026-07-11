import { beforeEach, describe, expect, mock, test } from 'bun:test'
import Database from 'libsql'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- Usage stub -----------------------------------------------------------
// syncFromKiroCli calls fetchUsageLimits() to resolve the account email. We
// mock it so the sync path is deterministic and offline:
//   - access token "email-<name>"  -> returns a real email (usageOk = true)
//   - anything else                -> returns NO email (placeholder path)
mock.module('../plugin/usage.js', () => ({
  fetchUsageLimits: async (auth: { access?: string }) => {
    if (typeof auth.access === 'string' && auth.access.startsWith('email-')) {
      return {
        usedCount: 5,
        limitCount: 100,
        email: `${auth.access.slice('email-'.length)}@example.com`
      }
    }
    return { usedCount: 0, limitCount: 0 }
  }
}))

const { createDeterministicAccountId } = await import('../plugin/accounts.js')
const { makePlaceholderEmail } = await import('../plugin/sync/kiro-cli-parser.js')
const { syncFromKiroCli } = await import('../plugin/sync/kiro-cli.js')
const { kiroDb } = await import('../plugin/storage/sqlite.js')

type FixtureToken = { key: string; data: Record<string, unknown> }

function hourFromNow(): string {
  return new Date(Date.now() + 3600000).toISOString()
}

/** Build a throwaway kiro-cli data.sqlite3 and point KIROCLI_DB_PATH at it. */
function makeCliFixture(tokens: FixtureToken[], profileArn?: string): string {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'kiro-cli-fx-')), 'data.sqlite3')
  const db = new Database(dbPath)
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)')
  db.exec('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)')
  for (const t of tokens) {
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)').run(t.key, JSON.stringify(t.data))
  }
  if (profileArn) {
    db.prepare('INSERT INTO state (key, value) VALUES (?, ?)').run(
      'api.codewhisperer.profile',
      JSON.stringify({ arn: profileArn })
    )
  }
  db.close()
  process.env.KIROCLI_DB_PATH = dbPath
  return dbPath
}

/** Direct handle to the singleton's underlying db, for test resets. */
function rawDb(): Database.Database {
  return (kiroDb as unknown as { db: Database.Database }).db
}

function accountIds(): string[] {
  return kiroDb.getAccounts().map((r: { id: string }) => r.id)
}

// A real-email IDC token whose usage lookup yields <name>@example.com.
function realEmailToken(name: string, clientId: string, profileArn: string): FixtureToken {
  return {
    key: 'kirocli:odic:token',
    data: {
      access_token: `email-${name}`,
      refresh_token: `refresh-${name}`,
      client_id: clientId,
      client_secret: `secret-${name}`,
      profile_arn: profileArn,
      region: 'us-east-1',
      expires_at: hourFromNow()
    }
  }
}

// A no-email IDC token -> sync falls back to makePlaceholderEmail().
function placeholderToken(clientId: string, profileArn: string): FixtureToken {
  return {
    key: 'kirocli:odic:token',
    data: {
      access_token: 'no-email-here',
      refresh_token: `refresh-${clientId}`,
      client_id: clientId,
      client_secret: `secret-${clientId}`,
      profile_arn: profileArn,
      region: 'us-east-1',
      expires_at: hourFromNow()
    }
  }
}

beforeEach(() => {
  const db = rawDb()
  db.exec('DELETE FROM accounts')
  db.exec('DELETE FROM removed_accounts')
  delete process.env.KIROCLI_DB_PATH
})

describe('account tombstone: storage roundtrip', () => {
  test('addRemovedAccount -> isAccountRemoved true; clearRemovedAccount -> false; list reflects contents', async () => {
    const id = 'tombstone-id-1'

    expect(await kiroDb.isAccountRemoved(id)).toBe(false)
    expect(await kiroDb.listRemovedAccounts()).not.toContain(id)

    await kiroDb.addRemovedAccount(id)
    expect(await kiroDb.isAccountRemoved(id)).toBe(true)
    expect(await kiroDb.listRemovedAccounts()).toContain(id)

    await kiroDb.clearRemovedAccount(id)
    expect(await kiroDb.isAccountRemoved(id)).toBe(false)
    expect(await kiroDb.listRemovedAccounts()).not.toContain(id)
  })

  test('listRemovedAccounts returns every tombstoned id', async () => {
    await kiroDb.addRemovedAccount('id-a')
    await kiroDb.addRemovedAccount('id-b')
    const list = await kiroDb.listRemovedAccounts()
    expect(list).toContain('id-a')
    expect(list).toContain('id-b')
    expect(list).toHaveLength(2)
  })
})

describe('account tombstone: removeAccount writes a tombstone', () => {
  test('AccountManager.removeAccount(acc) tombstones acc.id in kiroDb', async () => {
    const { AccountManager } = await import('../plugin/accounts.js')
    const acc = {
      id: createDeterministicAccountId('remove-me@example.com', 'idc', 'cid-rm', 'arn:rm'),
      email: 'remove-me@example.com',
      authMethod: 'idc' as const,
      region: 'us-east-1' as const,
      clientId: 'cid-rm',
      clientSecret: 'cs-rm',
      profileArn: 'arn:rm',
      refreshToken: 'refresh-rm',
      accessToken: 'access-rm',
      expiresAt: Date.now() + 3600000,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0
    }
    const manager = new AccountManager([acc], 'sticky')

    expect(await kiroDb.isAccountRemoved(acc.id)).toBe(false)

    manager.removeAccount(acc)

    // removeAccount fires the tombstone write as a fire-and-forget promise;
    // isAccountRemoved is a synchronous read wrapped in a promise, so await it
    // until the write lands (bounded, so a regression still fails the test).
    let removed = false
    for (let i = 0; i < 50 && !removed; i++) {
      removed = await kiroDb.isAccountRemoved(acc.id)
      if (!removed) await new Promise((r) => setTimeout(r, 10))
    }
    expect(removed).toBe(true)
    expect(await kiroDb.listRemovedAccounts()).toContain(acc.id)
    // The account row itself is gone from the manager's in-memory view.
    expect(manager.getAccounts().find((a) => a.id === acc.id)).toBeUndefined()
  })
})

describe('account tombstone: sync skips tombstoned exact id (MOMUS #1)', () => {
  test('a tombstoned deterministic id is skipped while a non-tombstoned account imports', async () => {
    const removedArn = 'arn:aws:codewhisperer:us-east-1:123:profile/removed'
    const keepArn = 'arn:aws:codewhisperer:us-east-1:123:profile/kept'

    // Tombstone the EXACT id the "removed" token would import as, computed the
    // same way syncFromKiroCli does: email from the usage stub (real@…),
    // authMethod idc, its clientId, its profileArn.
    const removedId = createDeterministicAccountId(
      'removed@example.com',
      'idc',
      'cid-removed',
      removedArn
    )
    await kiroDb.addRemovedAccount(removedId)

    const keptId = createDeterministicAccountId('kept@example.com', 'idc', 'cid-kept', keepArn)

    // Two separate fixtures, two sync runs (kiro-cli holds one token per key).
    makeCliFixture([realEmailToken('removed', 'cid-removed', removedArn)], removedArn)
    await syncFromKiroCli()

    makeCliFixture([realEmailToken('kept', 'cid-kept', keepArn)], keepArn)
    await syncFromKiroCli()

    const ids = accountIds()
    expect(ids).not.toContain(removedId) // tombstoned -> skipped
    expect(ids).toContain(keptId) // healthy -> imported normally
    expect(await kiroDb.isAccountRemoved(removedId)).toBe(true) // still tombstoned
  })
})

describe('account tombstone: placeholder-email stability (MOMUS #2)', () => {
  test('a no-email placeholder-only identity is re-created after a stale tombstone (bootstrap wins)', async () => {
    const arn = 'arn:aws:codewhisperer:us-east-1:123:profile/placeholder'
    const clientId = 'cid-placeholder'

    const placeholderEmail = makePlaceholderEmail('idc', 'us-east-1', clientId, arn)
    const placeholderId = createDeterministicAccountId(placeholderEmail, 'idc', clientId, arn)

    await kiroDb.addRemovedAccount(placeholderId)

    makeCliFixture([placeholderToken(clientId, arn)], arn)
    await syncFromKiroCli()

    // No same-identity REAL account coexists, so the stale tombstone must NOT
    // strand a placeholder-only identity: the tombstone is cleared and the
    // bootstrap placeholder is re-created so the user has a usable account.
    expect(accountIds()).toContain(placeholderId)
    expect(await kiroDb.isAccountRemoved(placeholderId)).toBe(false)
  })

  test('control: an identical no-email account WITHOUT a tombstone IS imported', async () => {
    const arn = 'arn:aws:codewhisperer:us-east-1:123:profile/placeholder-ctrl'
    const clientId = 'cid-placeholder-ctrl'
    const placeholderEmail = makePlaceholderEmail('idc', 'us-east-1', clientId, arn)
    const placeholderId = createDeterministicAccountId(placeholderEmail, 'idc', clientId, arn)

    makeCliFixture([placeholderToken(clientId, arn)], arn)
    await syncFromKiroCli()

    expect(accountIds()).toContain(placeholderId)
  })
})

describe('account tombstone: auto-sync does not clear tombstone (MOMUS #3)', () => {
  test('syncFromKiroCli leaves the tombstone intact; a deliberate clearRemovedAccount removes it', async () => {
    const arn = 'arn:aws:codewhisperer:us-east-1:123:profile/selfdefeat'
    const clientId = 'cid-selfdefeat'
    const id = createDeterministicAccountId('selfdefeat@example.com', 'idc', clientId, arn)

    await kiroDb.addRemovedAccount(id)

    // Auto-sync path: even though the CLI still has this credential, sync must
    // NOT revive it and must NOT clear the tombstone. This pins the invariant —
    // if sync ever called clearRemovedAccount(id), this assertion would fail.
    makeCliFixture([realEmailToken('selfdefeat', clientId, arn)], arn)
    await syncFromKiroCli()

    expect(await kiroDb.isAccountRemoved(id)).toBe(true)
    expect(accountIds()).not.toContain(id)

    // Deliberate login path (simulated): clearRemovedAccount DOES clear it,
    // after which a subsequent sync re-imports the account.
    await kiroDb.clearRemovedAccount(id)
    expect(await kiroDb.isAccountRemoved(id)).toBe(false)

    makeCliFixture([realEmailToken('selfdefeat', clientId, arn)], arn)
    await syncFromKiroCli()
    expect(accountIds()).toContain(id)
  })
})
