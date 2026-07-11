import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDeterministicId,
  deduplicateAccounts,
  mergeAccounts,
  withDatabaseLock
} from '../plugin/storage/locked-operations.js'
import type { ManagedAccount } from '../plugin/types.js'

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc',
    email: 'user@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: 'r',
    accessToken: 'a',
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides
  }
}

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'kiro-lock-')), 'kiro.db')
}

describe('withDatabaseLock', () => {
  test('creates the db file if missing, then runs the callback and returns its value', async () => {
    const path = tempDbPath()
    expect(existsSync(path)).toBe(false)

    const result = await withDatabaseLock(path, async () => {
      expect(existsSync(path)).toBe(true)
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(existsSync(path)).toBe(true)
  })

  test('releases the lock so a second acquisition succeeds', async () => {
    const path = tempDbPath()
    await withDatabaseLock(path, async () => 'first')
    const second = await withDatabaseLock(path, async () => 'second')
    expect(second).toBe('second')
  })

  test('serializes concurrent lock holders: no overlap of critical sections', async () => {
    const path = tempDbPath()
    let active = 0
    let maxConcurrent = 0
    const order: number[] = []

    const worker = (n: number) =>
      withDatabaseLock(path, async () => {
        active++
        maxConcurrent = Math.max(maxConcurrent, active)
        await new Promise((r) => setTimeout(r, 20))
        order.push(n)
        active--
      })

    await Promise.all([worker(1), worker(2), worker(3)])

    // proper-lockfile guarantees mutual exclusion: only one holder at a time.
    expect(maxConcurrent).toBe(1)
    expect(order.sort()).toEqual([1, 2, 3])
  })

  test('propagates the callback error but still releases the lock', async () => {
    const path = tempDbPath()
    await expect(
      withDatabaseLock(path, async () => {
        throw new Error('inner failure')
      })
    ).rejects.toThrow('inner failure')

    // Lock was released despite the throw: a subsequent acquisition works.
    const after = await withDatabaseLock(path, async () => 'recovered')
    expect(after).toBe('recovered')
  })

  test('reuses an existing (non-empty) db file without truncating it', async () => {
    const path = tempDbPath()
    await withDatabaseLock(path, async () => {})
    // Seed content, then lock again — the existsSync branch must NOT rewrite it.
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, 'SEEDED')
    await withDatabaseLock(path, async () => {})
    expect(readFileSync(path, 'utf8')).toBe('SEEDED')
  })
})

describe('createDeterministicId', () => {
  test('is a 64-char hex sha256 and stable for the same inputs', () => {
    const a = createDeterministicId('e@x.com', 'idc', 'cid', 'arn')
    const b = createDeterministicId('e@x.com', 'idc', 'cid', 'arn')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  test('differs when any component differs', () => {
    const base = createDeterministicId('e@x.com', 'idc', 'cid', 'arn')
    expect(createDeterministicId('other@x.com', 'idc', 'cid', 'arn')).not.toBe(base)
    expect(createDeterministicId('e@x.com', 'desktop', 'cid', 'arn')).not.toBe(base)
    expect(createDeterministicId('e@x.com', 'idc', 'cid2', 'arn')).not.toBe(base)
    expect(createDeterministicId('e@x.com', 'idc', 'cid', 'arn2')).not.toBe(base)
  })

  test('optional clientId/profileArn default to empty string', () => {
    const withEmpty = createDeterministicId('e@x.com', 'idc')
    const withExplicitEmpty = createDeterministicId('e@x.com', 'idc', '', '')
    expect(withEmpty).toBe(withExplicitEmpty)
  })
})

describe('mergeAccounts', () => {
  test('new incoming account (no existing match) is added as-is', () => {
    const incoming = account({ id: 'new' })
    const merged = mergeAccounts([], [incoming])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.id).toBe('new')
  })

  test('counters are merged to the max across existing and incoming', () => {
    const existing = account({ usedCount: 5, limitCount: 100, lastUsed: 10, lastSync: 1 })
    const incoming = account({ usedCount: 8, limitCount: 90, lastUsed: 5, lastSync: 20 })
    const merged = mergeAccounts([existing], [incoming])[0]!
    expect(merged.usedCount).toBe(8)
    expect(merged.limitCount).toBe(100)
    expect(merged.lastUsed).toBe(10)
    expect(merged.lastSync).toBe(20)
  })

  test('a permanent error on incoming forces the merged account unhealthy', () => {
    const existing = account({ isHealthy: true })
    const incoming = account({ isHealthy: false, unhealthyReason: 'HTTP_403' })
    const merged = mergeAccounts([existing], [incoming])[0]!
    expect(merged.isHealthy).toBe(false)
  })

  test('an existing permanent error keeps the account unhealthy even if incoming looks fine but is not recovered', () => {
    const existing = account({ isHealthy: false, unhealthyReason: 'invalid_grant' })
    // incoming is unhealthy too (not a recovery), so the permanent flag wins.
    const incoming = account({ isHealthy: false, unhealthyReason: undefined })
    const merged = mergeAccounts([existing], [incoming])[0]!
    expect(merged.isHealthy).toBe(false)
  })

  test('a healthy non-permanent incoming recovers a previously-unhealthy account and clears reason/recovery', () => {
    const existing = account({
      isHealthy: false,
      failCount: 7,
      unhealthyReason: 'Rate limited',
      recoveryTime: Date.now() + 1000
    })
    const incoming = account({ isHealthy: true, failCount: 0 })
    const merged = mergeAccounts([existing], [incoming])[0]!
    expect(merged.isHealthy).toBe(true)
    expect(merged.unhealthyReason).toBeUndefined()
    expect(merged.recoveryTime).toBeUndefined()
    expect(merged.failCount).toBe(0)
  })
})

describe('deduplicateAccounts', () => {
  test('keeps the variant with the greater lastUsed for the same id', () => {
    const older = account({ id: 'dup', lastUsed: 100, accessToken: 'old' })
    const newer = account({ id: 'dup', lastUsed: 200, accessToken: 'new' })
    const out = deduplicateAccounts([older, newer])
    expect(out).toHaveLength(1)
    expect(out[0]!.accessToken).toBe('new')
  })

  test('tie on lastUsed breaks toward the greater expiresAt', () => {
    const a = account({ id: 'dup', lastUsed: 50, expiresAt: 1000, accessToken: 'a' })
    const b = account({ id: 'dup', lastUsed: 50, expiresAt: 2000, accessToken: 'b' })
    const out = deduplicateAccounts([a, b])
    expect(out).toHaveLength(1)
    expect(out[0]!.accessToken).toBe('b')
  })

  test('distinct ids are all preserved', () => {
    const out = deduplicateAccounts([account({ id: 'x' }), account({ id: 'y' })])
    expect(out.map((a) => a.id).sort()).toEqual(['x', 'y'])
  })
})
