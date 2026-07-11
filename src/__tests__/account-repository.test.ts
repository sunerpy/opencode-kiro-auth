import { beforeEach, describe, expect, test } from 'bun:test'
import type Database from 'libsql'
import { AccountCache } from '../infrastructure/database/account-cache.js'
import { AccountRepository } from '../infrastructure/database/account-repository.js'
import { kiroDb } from '../plugin/storage/sqlite.js'
import type { ManagedAccount } from '../plugin/types.js'

// AccountRepository is a thin cache-in-front-of-kiroDb layer. These tests run
// against the REAL singleton kiroDb, which setup.ts has isolated to a
// throwaway temp dir (never the developer's real kiro.db). Each test resets
// the accounts table, so persistence + cache behavior are both asserted for
// real — no mocking of the DB.

function rawDb(): Database.Database {
  return (kiroDb as unknown as { db: Database.Database }).db
}

function makeAccount(o: Partial<ManagedAccount> & { id: string }): ManagedAccount {
  return {
    email: `${o.id}@example.com`,
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: `refresh-${o.id}`,
    accessToken: `access-${o.id}`,
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...o
  }
}

beforeEach(() => {
  rawDb().exec('DELETE FROM accounts')
  rawDb().exec('DELETE FROM removed_accounts')
})

describe('AccountRepository.findAll', () => {
  test('returns [] when the store is empty', async () => {
    const repo = new AccountRepository(new AccountCache(60000))
    expect(await repo.findAll()).toEqual([])
  })

  test('maps DB rows into ManagedAccount-shaped objects', async () => {
    await kiroDb.upsertAccount(makeAccount({ id: 'A', usedCount: 3, limitCount: 100 }))
    const repo = new AccountRepository(new AccountCache(60000))
    const all = await repo.findAll()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('A')
    expect(all[0].email).toBe('A@example.com')
    expect(all[0].authMethod).toBe('idc')
    expect(all[0].isHealthy).toBe(true) // is_healthy===1 -> true
    expect(all[0].usedCount).toBe(3)
    expect(all[0].limitCount).toBe(100)
  })

  test('a second findAll is served from cache (does not observe a direct DB insert)', async () => {
    await kiroDb.upsertAccount(makeAccount({ id: 'A' }))
    const repo = new AccountRepository(new AccountCache(60000))
    expect(await repo.findAll()).toHaveLength(1)

    // Insert straight into the DB, bypassing the repo/cache.
    await kiroDb.upsertAccount(makeAccount({ id: 'B' }))
    // Cached result still shows only 1 until the cache is invalidated.
    expect(await repo.findAll()).toHaveLength(1)

    repo.invalidateCache()
    expect(await repo.findAll()).toHaveLength(2)
  })
})

describe('AccountRepository.findById', () => {
  test('returns the account when present, null otherwise', async () => {
    await kiroDb.upsertAccount(makeAccount({ id: 'A' }))
    const repo = new AccountRepository(new AccountCache(60000))
    const found = await repo.findById('A')
    expect(found?.id).toBe('A')
    expect(await repo.findById('MISSING')).toBeNull()
  })
})

describe('AccountRepository.save', () => {
  test('persists to the DB and invalidates the cached list', async () => {
    const cache = new AccountCache(60000)
    const repo = new AccountRepository(cache)
    await repo.findAll() // warms the (empty) cache

    await repo.save(makeAccount({ id: 'A', usedCount: 9 }))

    // Persisted for real:
    expect(kiroDb.getAccounts().map((r: any) => r.id)).toContain('A')
    // And the stale empty cache was invalidated so findAll sees it.
    const all = await repo.findAll()
    expect(all.map((a) => a.id)).toContain('A')
    expect(all.find((a) => a.id === 'A')!.usedCount).toBe(9)
  })
})

describe('AccountRepository.delete', () => {
  test('removes the row and invalidates the cache', async () => {
    await kiroDb.upsertAccount(makeAccount({ id: 'A' }))
    const repo = new AccountRepository(new AccountCache(60000))
    expect(await repo.findAll()).toHaveLength(1)

    await repo.delete('A')
    expect(kiroDb.getAccounts()).toHaveLength(0)
    expect(await repo.findAll()).toHaveLength(0)
  })
})

describe('AccountRepository.batchSave', () => {
  test('persists multiple accounts and clears the whole cache', async () => {
    const repo = new AccountRepository(new AccountCache(60000))
    await repo.findAll() // warm empty cache

    await repo.batchSave([
      makeAccount({ id: 'A' }),
      makeAccount({ id: 'B' }),
      makeAccount({ id: 'C' })
    ])

    const ids = kiroDb.getAccounts().map((r: any) => r.id)
    expect(ids).toContain('A')
    expect(ids).toContain('B')
    expect(ids).toContain('C')
    // Cache invalidated -> findAll reflects all three.
    expect(await repo.findAll()).toHaveLength(3)
  })
})

describe('AccountRepository.findHealthyAccounts', () => {
  test('filters out unhealthy accounts', async () => {
    await kiroDb.upsertAccount(makeAccount({ id: 'A', isHealthy: true }))
    await kiroDb.upsertAccount(
      makeAccount({ id: 'B', isHealthy: false, unhealthyReason: 'HTTP_403', failCount: 10 })
    )
    const repo = new AccountRepository(new AccountCache(60000))
    const healthy = await repo.findHealthyAccounts()
    expect(healthy.map((a) => a.id)).toEqual(['A'])
  })
})
