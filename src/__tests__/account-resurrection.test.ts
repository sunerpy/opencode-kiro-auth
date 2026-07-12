import { describe, expect, test } from 'bun:test'
import type Database from 'libsql'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeterministicAccountId } from '../plugin/accounts.js'
import { createDatabase } from '../plugin/storage/sqlite.js'
import type { ManagedAccount } from '../plugin/types.js'

type TestDb = ReturnType<typeof createDatabase>
type SingleDbFixture = {
  readonly dir: string
  readonly db: TestDb
}
type SharedDbFixture = {
  readonly dir: string
  readonly first: TestDb
  readonly second: TestDb
}
type AccountSpec = {
  readonly email: string
  readonly clientId: string
  readonly profileArn?: string | undefined
  readonly id?: string
  readonly accessToken?: string
  readonly refreshToken?: string
}

function singleDbFixture(): SingleDbFixture {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-resurrection-'))
  return { dir, db: createDatabase(join(dir, 'kiro.db')) }
}

function sharedDbFixture(): SharedDbFixture {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-resurrection-'))
  const path = join(dir, 'kiro.db')
  return { dir, first: createDatabase(path), second: createDatabase(path) }
}

function closeSingleFixture(fixture: SingleDbFixture): void {
  fixture.db.close()
  rmSync(fixture.dir, { recursive: true, force: true })
}

function closeSharedFixture(fixture: SharedDbFixture): void {
  fixture.first.close()
  fixture.second.close()
  rmSync(fixture.dir, { recursive: true, force: true })
}

function makeIdcAccount(spec: AccountSpec): ManagedAccount {
  const profileFields = spec.profileArn ? { profileArn: spec.profileArn } : {}
  return {
    id: spec.id ?? createDeterministicAccountId(spec.email, 'idc', spec.clientId, spec.profileArn),
    email: spec.email,
    authMethod: 'idc',
    region: 'us-east-1',
    clientId: spec.clientId,
    clientSecret: `secret-${spec.clientId}`,
    ...profileFields,
    refreshToken: spec.refreshToken ?? `refresh-${spec.clientId}`,
    accessToken: spec.accessToken ?? `access-${spec.clientId}`,
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0
  }
}

function accountIds(db: TestDb): string[] {
  return db.getAccounts().map((row) => row.id)
}

function rawAccountIds(db: TestDb): string[] {
  return rawDb(db)
    .prepare('SELECT id FROM accounts ORDER BY id')
    .all()
    .map((row) => (row as { id: string }).id)
}

function rawDb(db: TestDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('account resurrection guard: atomic removal', () => {
  test('removeAccountWithTombstone rolls back the delete when the tombstone insert fails', async () => {
    const fixture = singleDbFixture()
    try {
      const stale = makeIdcAccount({ email: 'atomic-h1@example.com', clientId: 'client-atomic-h1' })
      await fixture.db.batchUpsertAccounts([stale])

      rawDb(fixture.db).exec('DROP TABLE removed_accounts')

      // This FAILS against a non-atomic two-step delete-then-tombstone implementation;
      // it passes only because DELETE + tombstone INSERT share one transaction with ROLLBACK on error.
      await expect(fixture.db.removeAccountWithTombstone(stale.id)).rejects.toThrow()
      expect(rawAccountIds(fixture.db)).toContain(stale.id)
    } finally {
      closeSingleFixture(fixture)
    }
  })

  test('removeAccountWithTombstone deletes and tombstones together, then blocks stale batch reinsert', async () => {
    const fixture = sharedDbFixture()
    try {
      const stale = makeIdcAccount({
        email: 'h1@example.com',
        clientId: 'client-h1',
        profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/h1'
      })
      await fixture.first.batchUpsertAccounts([stale])

      await fixture.first.removeAccountWithTombstone(stale.id)

      expect(accountIds(fixture.first)).not.toContain(stale.id)
      expect(await fixture.second.isAccountRemoved(stale.id)).toBe(true)

      await fixture.second.batchUpsertAccounts([
        makeIdcAccount({
          email: stale.email,
          clientId: stale.clientId ?? 'client-h1',
          profileArn: stale.profileArn,
          id: stale.id,
          accessToken: 'stale-process-access'
        })
      ])

      expect(accountIds(fixture.first)).not.toContain(stale.id)
      expect(await fixture.first.isAccountRemoved(stale.id)).toBe(true)
    } finally {
      closeSharedFixture(fixture)
    }
  })
})

describe('account resurrection guard: tombstone-filtered upserts', () => {
  test('upsertAccount drops a stale account whose id is tombstoned', async () => {
    const fixture = singleDbFixture()
    try {
      const tombstoned = makeIdcAccount({
        email: 'stale-h1@example.com',
        clientId: 'client-stale-h1'
      })
      await fixture.db.addRemovedAccount(tombstoned.id)

      await fixture.db.upsertAccount(tombstoned)

      expect(accountIds(fixture.db)).not.toContain(tombstoned.id)
      expect(await fixture.db.isAccountRemoved(tombstoned.id)).toBe(true)
    } finally {
      closeSingleFixture(fixture)
    }
  })

  test('batchUpsertAccounts filters tombstoned ids per account and persists healthy ids', async () => {
    const fixture = singleDbFixture()
    try {
      const tombstoned = makeIdcAccount({
        email: 'batch-h1@example.com',
        clientId: 'client-batch-h1'
      })
      const fresh = makeIdcAccount({ email: 'batch-h2@example.com', clientId: 'client-batch-h2' })
      await fixture.db.addRemovedAccount(tombstoned.id)

      await fixture.db.batchUpsertAccounts([tombstoned, fresh])

      expect(accountIds(fixture.db)).not.toContain(tombstoned.id)
      expect(accountIds(fixture.db)).toContain(fresh.id)
      expect(await fixture.db.isAccountRemoved(tombstoned.id)).toBe(true)
    } finally {
      closeSingleFixture(fixture)
    }
  })

  test('a stale process handle cannot resurrect an account removed by another handle', async () => {
    const fixture = sharedDbFixture()
    try {
      const stale = makeIdcAccount({ email: 'multi-h1@example.com', clientId: 'client-multi-h1' })
      await fixture.first.batchUpsertAccounts([stale])
      await fixture.first.removeAccountWithTombstone(stale.id)

      await fixture.second.batchUpsertAccounts([
        makeIdcAccount({
          email: stale.email,
          clientId: stale.clientId ?? 'client-multi-h1',
          id: stale.id,
          accessToken: 'stale-handle-access'
        })
      ])

      expect(accountIds(fixture.first)).not.toContain(stale.id)
      expect(accountIds(fixture.second)).not.toContain(stale.id)
      expect(await fixture.second.isAccountRemoved(stale.id)).toBe(true)
    } finally {
      closeSharedFixture(fixture)
    }
  })

  test('getAccounts hides already-resurrected tombstoned rows and the next write purges them', async () => {
    const fixture = singleDbFixture()
    try {
      const zombie = makeIdcAccount({ email: 'zombie@example.com', clientId: 'client-zombie' })
      const fresh = makeIdcAccount({ email: 'fresh@example.com', clientId: 'client-fresh' })

      await fixture.db.batchUpsertAccounts([zombie])
      await fixture.db.addRemovedAccount(zombie.id)

      expect(rawAccountIds(fixture.db)).toContain(zombie.id)
      expect(accountIds(fixture.db)).not.toContain(zombie.id)

      await fixture.db.batchUpsertAccounts([fresh])

      expect(rawAccountIds(fixture.db)).not.toContain(zombie.id)
      expect(accountIds(fixture.db)).toContain(fresh.id)
      expect(await fixture.db.isAccountRemoved(zombie.id)).toBe(true)
    } finally {
      closeSingleFixture(fixture)
    }
  })
})

describe('account resurrection guard: deliberate re-login', () => {
  test('clearRemovedAccount before upsert allows re-login while a tombstone alone blocks it', async () => {
    const fixture = singleDbFixture()
    try {
      const account = makeIdcAccount({ email: 'relogin@example.com', clientId: 'client-relogin' })
      await fixture.db.addRemovedAccount(account.id)

      await fixture.db.upsertAccount(account)
      expect(accountIds(fixture.db)).not.toContain(account.id)

      await fixture.db.clearRemovedAccount(account.id)
      await fixture.db.upsertAccount(
        makeIdcAccount({
          email: account.email,
          clientId: account.clientId ?? 'client-relogin',
          id: account.id,
          accessToken: 'relogin-access'
        })
      )

      expect(accountIds(fixture.db)).toContain(account.id)
      expect(await fixture.db.isAccountRemoved(account.id)).toBe(false)
    } finally {
      closeSingleFixture(fixture)
    }
  })
})
