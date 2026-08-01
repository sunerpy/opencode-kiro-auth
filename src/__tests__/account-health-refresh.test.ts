import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { ErrorHandler } from '../core/request/error-handler.js'
import { AccountCache } from '../infrastructure/database/account-cache.js'
import { AccountRepository } from '../infrastructure/database/account-repository.js'
import { AccountManager } from '../plugin/accounts.js'
import { createDatabase, DB_PATH, kiroDb } from '../plugin/storage/sqlite.js'
import type { ManagedAccount } from '../plugin/types.js'

const createdAccountIds = new Set<string>()

async function drainMicrotasks(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve()
}

async function waitForMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
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
  test('returns recovered account selection before starting its database write', async () => {
    const suffix = crypto.randomUUID()
    const account = makeAccount(`health-sync-selection-${suffix}`)
    account.failCount = 1
    account.isHealthy = false
    account.unhealthyReason = 'transient server error'
    account.recoveryTime = Date.now() - 1
    const manager = new AccountManager([account], 'sticky')
    const upsert = spyOn(kiroDb, 'upsertAccount').mockResolvedValue()

    try {
      const selected = manager.getCurrentOrNext()

      expect(selected?.id).toBe(account.id)
      expect(upsert).not.toHaveBeenCalled()

      await waitForMacrotask()
      expect(upsert).toHaveBeenCalledTimes(1)
    } finally {
      await waitForMacrotask()
      await drainMicrotasks()
      upsert.mockRestore()
    }
  })

  test('coalesces rapid same-account mutations to one in-flight write plus the latest snapshot', async () => {
    const suffix = crypto.randomUUID()
    const account = makeAccount(`health-write-order-${suffix}`)
    const manager = new AccountManager([account], 'sticky')
    const firstWrite = Promise.withResolvers<void>()
    const persistedSnapshots: ManagedAccount[] = []
    const upsert = spyOn(kiroDb, 'upsertAccount').mockImplementation((candidate) => {
      persistedSnapshots.push({ ...candidate })
      return persistedSnapshots.length === 1 ? firstWrite.promise : Promise.resolve()
    })

    try {
      manager.markRateLimited(account, 30_000)
      expect(upsert).not.toHaveBeenCalled()

      await waitForMacrotask()
      expect(persistedSnapshots).toHaveLength(1)

      manager.markRateLimited(account, 40_000)
      manager.markRateLimited(account, 50_000)
      manager.markRateLimited(account, 60_000)
      const finalCooldown = account.rateLimitResetTime
      await waitForMacrotask()
      expect(persistedSnapshots).toHaveLength(1)

      firstWrite.resolve()
      await drainMicrotasks()
      await waitForMacrotask()
      await drainMicrotasks()

      expect(persistedSnapshots).toHaveLength(2)
      expect(persistedSnapshots[1]?.rateLimitResetTime).toBe(finalCooldown)
    } finally {
      firstWrite.resolve()
      await waitForMacrotask()
      await drainMicrotasks()
      upsert.mockRestore()
    }
  })

  test('does not let a database refresh undo a single-account permanent failure', async () => {
    const suffix = crypto.randomUUID()
    const account = makeAccount(`health-permanent-${suffix}`)
    const unrelated = makeAccount(`health-permanent-unrelated-${suffix}`)
    await kiroDb.upsertAccount(account)
    const manager = new AccountManager([account], 'sticky')
    const repository = new AccountRepository(new AccountCache(60_000))
    const handler = new ErrorHandler(
      { rate_limit_max_retries: 3, rate_limit_retry_delay_ms: 5_000 },
      manager,
      repository
    )
    const externalConnection = createDatabase(DB_PATH)

    try {
      const result = await handler.handle(
        new Error('suspended'),
        new Response(JSON.stringify({ reason: 'TEMPORARILY_SUSPENDED', message: 'suspended' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        }),
        account,
        { retry: 0 },
        () => {}
      )
      await externalConnection.upsertAccount(unrelated)

      const selected = manager.getCurrentOrNext()
      const observed = manager.getAccounts().find((candidate) => candidate.id === account.id)

      expect(result.shouldRetry).toBe(false)
      expect(selected).toBeNull()
      expect(observed?.failCount).toBe(10)
      expect(observed?.isHealthy).toBe(false)
      expect(observed?.unhealthyReason).toContain('Account Suspended')
    } finally {
      await waitForMacrotask()
      await drainMicrotasks()
      externalConnection.close()
    }
  })

  test('persisted health recovery invalidates the repository cache immediately', async () => {
    const suffix = crypto.randomUUID()
    const account = makeAccount(`health-cache-${suffix}`)
    account.failCount = 2
    account.isHealthy = false
    account.unhealthyReason = 'transient server error'
    await kiroDb.upsertAccount(account)
    const repository = new AccountRepository(new AccountCache(60_000))
    const cachedBefore = (await repository.findById(account.id)) as ManagedAccount | null
    const persisted = Promise.withResolvers<void>()
    const realUpsert = kiroDb.upsertAccount.bind(kiroDb)
    const upsert = spyOn(kiroDb, 'upsertAccount').mockImplementation(async (candidate) => {
      await realUpsert(candidate)
      if (candidate.id === account.id) persisted.resolve()
    })
    const manager = new AccountManager([account], 'sticky', {
      invalidateAccountCache: (accountId) => repository.invalidateAccount(accountId)
    })

    try {
      expect(cachedBefore?.failCount).toBe(2)

      manager.markHealthy(account)
      await persisted.promise
      await drainMicrotasks()
      const observedAfter = (await repository.findById(account.id)) as ManagedAccount | null

      expect(observedAfter?.failCount).toBe(0)
      expect(observedAfter?.isHealthy).toBe(true)
      expect(observedAfter?.unhealthyReason ?? undefined).toBeUndefined()
    } finally {
      upsert.mockRestore()
    }
  })

  test('does not revert a 500-driven fail count while its persistence is pending', async () => {
    const suffix = crypto.randomUUID()
    const accountA = makeAccount(`health-failure-A-${suffix}`)
    const accountB = makeAccount(`health-failure-B-${suffix}`)
    const unrelated = makeAccount(`health-failure-unrelated-${suffix}`)
    await kiroDb.batchUpsertAccounts([accountA, accountB])
    const manager = new AccountManager([accountA, accountB], 'sticky')
    const externalConnection = createDatabase(DB_PATH)
    const pendingWrite = Promise.withResolvers<void>()
    const realUpsert = kiroDb.upsertAccount.bind(kiroDb)
    const upsert = spyOn(kiroDb, 'upsertAccount').mockImplementation((account) =>
      account.id === accountA.id ? pendingWrite.promise : realUpsert(account)
    )

    try {
      expect(manager.recordFailure(accountA)).toBe(1)
      await externalConnection.upsertAccount(unrelated)

      manager.getCurrentOrNext()
      const refreshedA = manager.getAccounts().find((account) => account.id === accountA.id)

      expect(refreshedA?.failCount).toBe(1)
    } finally {
      await waitForMacrotask()
      expect(upsert).toHaveBeenCalledTimes(1)
      pendingWrite.resolve()
      await drainMicrotasks()
      expect(upsert).toHaveBeenCalledTimes(1)
      upsert.mockRestore()
      externalConnection.close()
    }
  })

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
      await waitForMacrotask()
      expect(upsert).toHaveBeenCalledTimes(1)
      pendingWrite.resolve()
      await drainMicrotasks()
      expect(upsert).toHaveBeenCalledTimes(1)
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

      await waitForMacrotask()
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
