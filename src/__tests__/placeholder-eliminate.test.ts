import { beforeEach, describe, expect, mock, test } from 'bun:test'
import Database from 'libsql'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same offline usage stub contract as account-tombstone.test.ts:
//   access token "email-<name>" -> returns <name>@example.com (usageOk = true)
//   anything else               -> returns NO email (placeholder path)
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

function makeCliFixture(tokens: FixtureToken[], profileArn?: string): string {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'kiro-cli-elim-')), 'data.sqlite3')
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

function rawDb(): Database.Database {
  return (kiroDb as unknown as { db: Database.Database }).db
}

function accountIds(): string[] {
  return kiroDb.getAccounts().map((r: { id: string }) => r.id)
}

function accountById(id: string): any | undefined {
  return kiroDb.getAccounts().find((r: { id: string }) => r.id === id)
}

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

function noEmailToken(clientId: string, profileArn: string, name = clientId): FixtureToken {
  return {
    key: 'kirocli:odic:token',
    data: {
      access_token: `fresh-access-${name}`,
      refresh_token: `fresh-refresh-${name}`,
      client_id: clientId,
      client_secret: `secret-${name}`,
      profile_arn: profileArn,
      region: 'us-east-1',
      expires_at: hourFromNow()
    }
  }
}

async function insertPlaceholderRow(clientId: string, arn: string): Promise<string> {
  const email = makePlaceholderEmail('idc', 'us-east-1', clientId, arn)
  const id = createDeterministicAccountId(email, 'idc', clientId, arn)
  await kiroDb.upsertAccount({
    id,
    email,
    authMethod: 'idc',
    region: 'us-east-1' as const,
    clientId,
    clientSecret: `secret-${clientId}`,
    profileArn: arn,
    refreshToken: `stale-refresh-${clientId}`,
    accessToken: `stale-access-${clientId}`,
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0
  })
  return id
}

beforeEach(() => {
  const db = rawDb()
  db.exec('DELETE FROM accounts')
  db.exec('DELETE FROM removed_accounts')
  delete process.env.KIROCLI_DB_PATH
})

describe('placeholder elimination at source', () => {
  test('real-email sync deletes + tombstones a pre-existing same-identity placeholder', async () => {
    const arn = 'arn:aws:codewhisperer:us-east-1:123:profile/cleanup'
    const clientId = 'cid-cleanup'

    const placeholderId = await insertPlaceholderRow(clientId, arn)
    expect(accountIds()).toContain(placeholderId)

    const realId = createDeterministicAccountId('cleanup@example.com', 'idc', clientId, arn)

    makeCliFixture([realEmailToken('cleanup', clientId, arn)], arn)
    await syncFromKiroCli()

    expect(accountIds()).not.toContain(placeholderId)
    expect(await kiroDb.isAccountRemoved(placeholderId)).toBe(true)
    expect(accountIds()).toContain(realId)
  })

  test('REUSE-path cleanup with a ROTATED clientId placeholder (real kiro.db scenario): no-email round resolves real email via reuse -> deletes + tombstones the lingering same-identity placeholder', async () => {
    const arn = 'arn:aws:codewhisperer:us-east-1:123:profile/reuse-clean'
    const tokenClientId = 'cid-current'
    const placeholderClientId = 'cid-rotated-old'
    const realId = createDeterministicAccountId('reuseclean@example.com', 'idc', tokenClientId, arn)

    // Real account: current clientId. Placeholder: a DIFFERENT (rotated)
    // clientId from an earlier device registration, same profileArn. This
    // mirrors the live kiro.db where the placeholder's clientId != the token's.
    await kiroDb.upsertAccount({
      id: realId,
      email: 'reuseclean@example.com',
      authMethod: 'idc',
      region: 'us-east-1' as const,
      clientId: tokenClientId,
      clientSecret: `secret-${tokenClientId}`,
      profileArn: arn,
      refreshToken: 'stale-refresh',
      accessToken: 'stale-access',
      expiresAt: Date.now() + 1000,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0
    })
    const placeholderId = await insertPlaceholderRow(placeholderClientId, arn)
    expect(accountIds()).toContain(placeholderId)

    // fetchUsageLimits returns NO email -> usageOk stays false; the real email
    // is obtained via the REUSE path. Cleanup must still fire (hasRealEmail),
    // and must match the placeholder by its OWN fields despite the rotated id.
    makeCliFixture([noEmailToken(tokenClientId, arn, 'reuseclean')], arn)
    await syncFromKiroCli()

    expect(accountIds()).not.toContain(placeholderId)
    expect(await kiroDb.isAccountRemoved(placeholderId)).toBe(true)
    const row = accountById(realId)
    expect(row).toBeDefined()
    expect(row.access_token).toBe('fresh-access-reuseclean')
    expect(row.refresh_token).toBe('fresh-refresh-reuseclean')
  })

  test('no-email sync with an existing same-identity REAL account reuses it and refreshes tokens (no skip)', async () => {
    const arn = 'arn:aws:codewhisperer:us-east-1:123:profile/reuse'
    const clientId = 'cid-reuse'
    const realId = createDeterministicAccountId('reuse@example.com', 'idc', clientId, arn)

    // Seed a real account with STALE tokens and an expiry OLDER than the CLI
    // token, so the fresh-enough early-continue does not trigger and the
    // refresh must land.
    await kiroDb.upsertAccount({
      id: realId,
      email: 'reuse@example.com',
      authMethod: 'idc',
      region: 'us-east-1' as const,
      clientId,
      clientSecret: `secret-${clientId}`,
      profileArn: arn,
      refreshToken: 'stale-refresh',
      accessToken: 'stale-access',
      expiresAt: Date.now() + 1000,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0
    })

    makeCliFixture([noEmailToken(clientId, arn, 'reuse')], arn)
    await syncFromKiroCli()

    const placeholderId = createDeterministicAccountId(
      makePlaceholderEmail('idc', 'us-east-1', clientId, arn),
      'idc',
      clientId,
      arn
    )
    expect(accountIds()).not.toContain(placeholderId)

    const row = accountById(realId)
    expect(row).toBeDefined()
    expect(row.access_token).toBe('fresh-access-reuse')
    expect(row.refresh_token).toBe('fresh-refresh-reuse')
    expect(row.email).toBe('reuse@example.com')
  })

  test('no-email sync with NO same-identity real account creates the bootstrap placeholder', async () => {
    const arn = 'arn:aws:codewhisperer:us-east-1:123:profile/bootstrap'
    const clientId = 'cid-bootstrap'
    const placeholderId = createDeterministicAccountId(
      makePlaceholderEmail('idc', 'us-east-1', clientId, arn),
      'idc',
      clientId,
      arn
    )

    makeCliFixture([noEmailToken(clientId, arn, 'bootstrap')], arn)
    await syncFromKiroCli()

    expect(accountIds()).toContain(placeholderId)
  })

  test('a real-email row at a different id (same identity) is never deleted by cleanup', async () => {
    const arn = 'arn:aws:codewhisperer:us-east-1:123:profile/keepreal'
    const clientId = 'cid-keepreal'

    // A pre-existing REAL account under a DIFFERENT email than the sync will
    // resolve -> different id, same identity. Its email is NOT placeholder
    // format, so the exact-match guard must leave it untouched.
    const otherRealId = createDeterministicAccountId('older@example.com', 'idc', clientId, arn)
    await kiroDb.upsertAccount({
      id: otherRealId,
      email: 'older@example.com',
      authMethod: 'idc',
      region: 'us-east-1' as const,
      clientId,
      clientSecret: `secret-${clientId}`,
      profileArn: arn,
      refreshToken: 'other-refresh',
      accessToken: 'other-access',
      expiresAt: Date.now() + 3600000,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0
    })

    makeCliFixture([realEmailToken('keepreal', clientId, arn)], arn)
    await syncFromKiroCli()

    expect(accountIds()).toContain(otherRealId)
    expect(await kiroDb.isAccountRemoved(otherRealId)).toBe(false)
    expect(accountById(otherRealId).email).toBe('older@example.com')
  })

  test('bootstrap-after-tombstone: tombstoned placeholder id + NO real account -> placeholder re-created', async () => {
    const arn = 'arn:aws:codewhisperer:us-east-1:123:profile/tomb-boot'
    const clientId = 'cid-tomb-boot'
    const placeholderId = createDeterministicAccountId(
      makePlaceholderEmail('idc', 'us-east-1', clientId, arn),
      'idc',
      clientId,
      arn
    )

    await kiroDb.addRemovedAccount(placeholderId)

    makeCliFixture([noEmailToken(clientId, arn, 'tombboot')], arn)
    await syncFromKiroCli()

    expect(accountIds()).toContain(placeholderId)
    expect(await kiroDb.isAccountRemoved(placeholderId)).toBe(false)
  })

  test('tombstoned placeholder id + real account exists -> placeholder stays gone', async () => {
    const arn = 'arn:aws:codewhisperer:us-east-1:123:profile/tomb-real'
    const clientId = 'cid-tomb-real'
    const placeholderId = createDeterministicAccountId(
      makePlaceholderEmail('idc', 'us-east-1', clientId, arn),
      'idc',
      clientId,
      arn
    )
    const realId = createDeterministicAccountId('tombreal@example.com', 'idc', clientId, arn)

    await kiroDb.addRemovedAccount(placeholderId)

    makeCliFixture([realEmailToken('tombreal', clientId, arn)], arn)
    await syncFromKiroCli()

    expect(accountIds()).toContain(realId)
    expect(accountIds()).not.toContain(placeholderId)
    expect(await kiroDb.isAccountRemoved(placeholderId)).toBe(true)
  })
})
