import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { AccountManager } from '../plugin/accounts.js'
import { createDatabase, DB_PATH, kiroDb } from '../plugin/storage/sqlite.js'
import type { ManagedAccount } from '../plugin/types.js'

const createdAccountIds = new Set<string>()

async function drainMicrotasks(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve()
}

function makeAccount(id: string): ManagedAccount {
  createdAccountIds.add(id)
  return {
    id,
    email: `${id}@example.com`,
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: `refresh-${id}`,
    accessToken: `access-${id}`,
    expiresAt: Date.now() + 60_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0
  }
}

afterEach(async () => {
  for (const id of createdAccountIds) await kiroDb.deleteAccount(id)
  createdAccountIds.clear()
})

describe('AccountManager account-health refresh', () => {
  test('does not revert a local cooldown while its same-process persistence is pending', async () => {
    const suffix = crypto.randomUUID()
    const accountA = makeAccount(`health-pending-A-${suffix}`)
    const accountB = makeAccount(`health-pending-B-${suffix}`)
    const unrelated = makeAccount(`health-pending-unrelated-${suffix}`)
    await kiroDb.batchUpsertAccounts([accountA, accountB])
    const manager = new AccountManager([accountA, accountB], 'sticky')
    const externalConnection = createDatabase(DB_PATH)
    const pendingWrite = Promise.withResolvers<void>()
    const realUpsert = kiroDb.upsertAccount.bind(kiroDb)
    const upsert = spyOn(kiroDb, 'upsertAccount').mockImplementation((account) =>
      account.id === accountA.id ? pendingWrite.promise : realUpsert(account)
    )

    try {
      manager.markRateLimited(accountA, 30_000)
      const localCooldownUntil = accountA.rateLimitResetTime
      await externalConnection.upsertAccount(unrelated)

      const selected = manager.getCurrentOrNext()
      const refreshedA = manager.getAccounts().find((account) => account.id === accountA.id)

      expect(refreshedA?.rateLimitResetTime).toBe(localCooldownUntil)
      expect(refreshedA?.rateLimitResetTime).toBeGreaterThan(Date.now())
      expect(selected?.id).toBe(accountB.id)
    } finally {
      pendingWrite.resolve()
      await drainMicrotasks()
      upsert.mockRestore()
      externalConnection.close()
    }
  })

  test('keeps a rejected local cooldown and clears its pending guard for later DB refreshes', async () => {
    const suffix = crypto.randomUUID()
    const accountA = makeAccount(`health-rejected-A-${suffix}`)
    const accountB = makeAccount(`health-rejected-B-${suffix}`)
    const unrelated = makeAccount(`health-rejected-unrelated-${suffix}`)
    await kiroDb.batchUpsertAccounts([accountA, accountB])
    const manager = new AccountManager([accountA, accountB], 'sticky')
    const externalConnection = createDatabase(DB_PATH)
    const pendingWrite = Promise.withResolvers<void>()
    const realUpsert = kiroDb.upsertAccount.bind(kiroDb)
    const upsert = spyOn(kiroDb, 'upsertAccount').mockImplementation((account) =>
      account.id === accountA.id ? pendingWrite.promise : realUpsert(account)
    )

    try {
      manager.markRateLimited(accountA, 30_000)
      const localCooldownUntil = accountA.rateLimitResetTime
      await externalConnection.upsertAccount(unrelated)
      manager.getCurrentOrNext()

      pendingWrite.reject(new Error('simulated cooldown persistence failure'))
      await drainMicrotasks()

      const afterRejection = manager.getAccounts().find((account) => account.id === accountA.id)
      expect(afterRejection?.rateLimitResetTime).toBe(localCooldownUntil)
      expect(afterRejection?.rateLimitResetTime).toBeGreaterThan(Date.now())

      const externalCooldownUntil = localCooldownUntil + 10_000
      await externalConnection.upsertAccount({
        ...accountA,
        rateLimitResetTime: externalCooldownUntil
      })
      manager.getCurrentOrNext()

      const afterExternalRefresh = manager
        .getAccounts()
        .find((account) => account.id === accountA.id)
      expect(afterExternalRefresh?.rateLimitResetTime).toBe(externalCooldownUntil)
    } finally {
      upsert.mockRestore()
      externalConnection.close()
    }
  })

  test('selection observes a cooldown committed by another connection to the same database', async () => {
    const suffix = crypto.randomUUID()
    const accountA = makeAccount(`health-refresh-A-${suffix}`)
    const accountB = makeAccount(`health-refresh-B-${suffix}`)
    await kiroDb.batchUpsertAccounts([accountA, accountB])
    const manager = new AccountManager([accountA, accountB], 'sticky')
    const externalConnection = createDatabase(DB_PATH)
    const cooldownUntil = Date.now() + 30_000
    const dataVersionBefore = kiroDb.getDataVersion()

    try {
      await externalConnection.upsertAccount({
        ...accountA,
        rateLimitResetTime: cooldownUntil
      })
      const persistedA = externalConnection.getAccounts().find((row) => row.id === accountA.id) as
        { rate_limit_reset?: number } | undefined

      const selected = manager.getCurrentOrNext()
      const refreshedA = manager.getAccounts().find((account) => account.id === accountA.id)

      expect(persistedA?.rate_limit_reset).toBe(cooldownUntil)
      expect(kiroDb.getDataVersion()).toBeGreaterThan(dataVersionBefore)
      expect(selected?.id).toBe(accountB.id)
      expect(refreshedA?.rateLimitResetTime).toBe(cooldownUntil)
      expect(refreshedA?.isHealthy).toBe(true)
    } finally {
      externalConnection.close()
    }
  })
})
