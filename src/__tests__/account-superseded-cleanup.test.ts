import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeterministicAccountId } from '../plugin/accounts.js'
import { createDatabase } from '../plugin/storage/sqlite.js'
import { makePlaceholderEmail } from '../plugin/sync/kiro-cli-parser.js'
import type { ManagedAccount } from '../plugin/types.js'

type TestDb = ReturnType<typeof createDatabase>
type DbFixture = {
  readonly dir: string
  readonly db: TestDb
}
type AccountSpec = {
  readonly email: string
  readonly clientId: string
  readonly profileArn?: string | undefined
}

function dbFixture(): DbFixture {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-superseded-'))
  return { dir, db: createDatabase(join(dir, 'kiro.db')) }
}

function closeFixture(fixture: DbFixture): void {
  fixture.db.close()
  rmSync(fixture.dir, { recursive: true, force: true })
}

function makeIdcAccount(spec: AccountSpec): ManagedAccount {
  const profileFields = spec.profileArn ? { profileArn: spec.profileArn } : {}
  return {
    id: createDeterministicAccountId(spec.email, 'idc', spec.clientId, spec.profileArn),
    email: spec.email,
    authMethod: 'idc',
    region: 'us-east-1',
    clientId: spec.clientId,
    clientSecret: `secret-${spec.clientId}`,
    ...profileFields,
    refreshToken: `refresh-${spec.clientId}`,
    accessToken: `access-${spec.clientId}`,
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0
  }
}

function accountIds(db: TestDb): string[] {
  return db.getAccounts().map((row) => row.id)
}

describe('account cleanup: superseded same-identity rows', () => {
  test('cleanupSupersededIdentities deletes and tombstones an older clientId for the same email and profile', async () => {
    const fixture = dbFixture()
    try {
      const email = 'same-identity@example.com'
      const profileArn = 'arn:aws:codewhisperer:us-east-1:123:profile/same'
      const oldAccount = makeIdcAccount({ email, clientId: 'client-old', profileArn })
      const newAccount = makeIdcAccount({ email, clientId: 'client-new', profileArn })
      await fixture.db.batchUpsertAccounts([oldAccount, newAccount])

      const supersededIds = await fixture.db.cleanupSupersededIdentities(
        newAccount.id,
        email,
        'idc',
        profileArn
      )

      expect(supersededIds).toEqual([oldAccount.id])
      expect(accountIds(fixture.db)).not.toContain(oldAccount.id)
      expect(accountIds(fixture.db)).toContain(newAccount.id)
      expect(await fixture.db.isAccountRemoved(oldAccount.id)).toBe(true)
    } finally {
      closeFixture(fixture)
    }
  })

  test('cleanupSupersededIdentities preserves a different profileArn for the same email', async () => {
    const fixture = dbFixture()
    try {
      const email = 'multi-profile@example.com'
      const profileA = 'arn:aws:codewhisperer:us-east-1:123:profile/A'
      const profileB = 'arn:aws:codewhisperer:us-east-1:123:profile/B'
      const accountA = makeIdcAccount({ email, clientId: 'client-A', profileArn: profileA })
      const accountB = makeIdcAccount({ email, clientId: 'client-B', profileArn: profileB })
      await fixture.db.batchUpsertAccounts([accountA, accountB])

      const supersededIds = await fixture.db.cleanupSupersededIdentities(
        accountA.id,
        email,
        'idc',
        profileA
      )

      expect(supersededIds).toEqual([])
      expect(accountIds(fixture.db)).toContain(accountA.id)
      expect(accountIds(fixture.db)).toContain(accountB.id)
      expect(await fixture.db.isAccountRemoved(accountB.id)).toBe(false)
    } finally {
      closeFixture(fixture)
    }
  })

  test('cleanupSupersededIdentities with a NULL profile only supersedes NULL-profile rows', async () => {
    const fixture = dbFixture()
    try {
      const email = 'null-profile@example.com'
      const keepNull = makeIdcAccount({ email, clientId: 'client-null-keep' })
      const oldNull = makeIdcAccount({ email, clientId: 'client-null-old' })
      const arnAccount = makeIdcAccount({
        email,
        clientId: 'client-arn-x',
        profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/X'
      })
      await fixture.db.batchUpsertAccounts([keepNull, oldNull, arnAccount])

      const supersededIds = await fixture.db.cleanupSupersededIdentities(
        keepNull.id,
        email,
        'idc',
        undefined
      )

      expect(supersededIds).toEqual([oldNull.id])
      expect(accountIds(fixture.db)).toContain(keepNull.id)
      expect(accountIds(fixture.db)).not.toContain(oldNull.id)
      expect(accountIds(fixture.db)).toContain(arnAccount.id)
      expect(await fixture.db.isAccountRemoved(oldNull.id)).toBe(true)
      expect(await fixture.db.isAccountRemoved(arnAccount.id)).toBe(false)
    } finally {
      closeFixture(fixture)
    }
  })

  test('placeholder-email cleanup backstop does not delete a real-email row with the same profile', async () => {
    const fixture = dbFixture()
    try {
      const profileArn = 'arn:aws:codewhisperer:us-east-1:123:profile/placeholder-guard'
      const realAccount = makeIdcAccount({
        email: 'real-placeholder-guard@example.com',
        clientId: 'client-real-placeholder-guard',
        profileArn
      })
      const placeholderEmail = makePlaceholderEmail(
        'idc',
        'us-east-1',
        'client-placeholder-guard',
        profileArn
      )
      const placeholderAccount = makeIdcAccount({
        email: placeholderEmail,
        clientId: 'client-placeholder-guard',
        profileArn
      })
      await fixture.db.batchUpsertAccounts([realAccount, placeholderAccount])

      const supersededIds = await fixture.db.cleanupSupersededIdentities(
        placeholderAccount.id,
        placeholderEmail,
        'idc',
        profileArn
      )

      expect(supersededIds).toEqual([])
      expect(accountIds(fixture.db)).toContain(realAccount.id)
      expect(accountIds(fixture.db)).toContain(placeholderAccount.id)
      expect(await fixture.db.isAccountRemoved(realAccount.id)).toBe(false)
    } finally {
      closeFixture(fixture)
    }
  })
})
