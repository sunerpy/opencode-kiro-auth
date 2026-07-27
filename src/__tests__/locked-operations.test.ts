import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import {
  createDeterministicId,
  deduplicateAccounts,
  getRefreshLockPath,
  mergeAccounts,
  withDatabaseLockSync,
  withRefreshLock
} from '../plugin/storage/locked-operations.js'
import { createDatabase } from '../plugin/storage/sqlite.js'
import type { ManagedAccount } from '../plugin/types.js'

type AccountRow = {
  id: string
  refresh_token: string
  access_token: string
  expires_at: number
}

type UsageRow = {
  id: string
  used_count: number
  limit_count: number
  overage_count: number
  last_sync: number
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | null = null
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  if (!resolvePromise) {
    throw new Error('Deferred resolver was not initialized')
  }
  return { promise, resolve: resolvePromise }
}

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

function tempDbFixture(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-lock-'))
  return { dir, path: join(dir, 'kiro.db') }
}

function removeRefreshLock(accountId: string): void {
  rmSync(getRefreshLockPath(accountId), { force: true })
}

function lockStatEnoent(lockPath: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, statx '${lockPath}'`) as NodeJS.ErrnoException,
    {
      code: 'ENOENT',
      syscall: 'statx',
      path: lockPath
    }
  )
}

function onlyMergedAccount(accounts: ManagedAccount[]): ManagedAccount {
  const merged = accounts[0]
  if (!merged) {
    throw new Error('Expected one merged account')
  }
  return merged
}

function tokenTripleMatches(candidate: ManagedAccount, source: ManagedAccount): boolean {
  return (
    candidate.refreshToken === source.refreshToken &&
    candidate.accessToken === source.accessToken &&
    candidate.expiresAt === source.expiresAt
  )
}

function expectWholeTokenTripleFromOneInput(
  merged: ManagedAccount,
  existing: ManagedAccount,
  incoming: ManagedAccount
): void {
  const matchesExisting = tokenTripleMatches(merged, existing)
  const matchesIncoming = tokenTripleMatches(merged, incoming)
  expect(matchesExisting !== matchesIncoming).toBe(true)
}

describe('withDatabaseLockSync', () => {
  test('retries a transient lock-directory ENOENT, then runs and releases exactly once', () => {
    const path = tempDbPath()
    const originalLockSync = lockfile.lockSync
    let lockAttempts = 0
    let callbackCalls = 0
    let releaseCalls = 0
    const lockSpy = spyOn(lockfile, 'lockSync').mockImplementation((lockPath, options) => {
      if (lockPath !== path) return originalLockSync(lockPath, options)

      lockAttempts++
      if (lockAttempts === 1) {
        throw lockStatEnoent(`${lockPath}.lock`)
      }
      return () => {
        releaseCalls++
      }
    })

    try {
      const result = withDatabaseLockSync(path, () => {
        callbackCalls++
        return 'ok'
      })

      expect(result).toBe('ok')
      expect(lockAttempts).toBe(2)
      expect(callbackCalls).toBe(1)
      expect(releaseCalls).toBe(1)
    } finally {
      lockSpy.mockRestore()
    }
  })

  test('creates the db file if missing, runs the callback, and returns its value', () => {
    const path = tempDbPath()
    expect(existsSync(path)).toBe(false)

    const result = withDatabaseLockSync(path, () => {
      expect(existsSync(path)).toBe(true)
      return 'ok'
    })

    expect(result).toBe('ok')
  })

  test('propagates the callback error but still releases the lock', () => {
    const path = tempDbPath()
    expect(() =>
      withDatabaseLockSync(path, () => {
        throw new Error('inner failure')
      })
    ).toThrow('inner failure')

    const after = withDatabaseLockSync(path, () => 'recovered')
    expect(after).toBe('recovered')
  })

  test('releases the lock so a subsequent sync acquisition succeeds', () => {
    const path = tempDbPath()
    expect(withDatabaseLockSync(path, () => 'first')).toBe('first')
    expect(withDatabaseLockSync(path, () => 'second')).toBe('second')
  })
})

describe('withRefreshLock', () => {
  test('retries a transient lock-directory ENOENT, then runs and releases exactly once', async () => {
    const accountId = 'refresh-enoent-retry'
    const targetLockPath = getRefreshLockPath(accountId)
    removeRefreshLock(accountId)
    const originalLock = lockfile.lock
    let lockAttempts = 0
    let callbackCalls = 0
    let releaseCalls = 0
    const lockSpy = spyOn(lockfile, 'lock').mockImplementation(async (lockPath, options) => {
      if (lockPath !== targetLockPath) return originalLock(lockPath, options)

      lockAttempts++
      if (lockAttempts === 1) {
        throw lockStatEnoent(`${lockPath}.lock`)
      }
      return async () => {
        releaseCalls++
      }
    })

    try {
      const result = await withRefreshLock(accountId, async () => {
        callbackCalls++
        return 'ok'
      })

      expect(result).toBe('ok')
      expect(lockAttempts).toBe(2)
      expect(callbackCalls).toBe(1)
      expect(releaseCalls).toBe(1)
    } finally {
      lockSpy.mockRestore()
      removeRefreshLock(accountId)
    }
  })

  test('waits through sustained contention until the refresh lock is released within the deadline', async () => {
    const accountId = 'refresh-sustained-contention'
    removeRefreshLock(accountId)
    const firstEntered = deferred()
    const releaseFirst = deferred()

    try {
      const first = withRefreshLock(accountId, async () => {
        firstEntered.resolve()
        await releaseFirst.promise
      })
      await firstEntered.promise

      const second = withRefreshLock(accountId, async () => 'second')
      const secondOutcome = second.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error })
      )
      await new Promise((resolve) => setTimeout(resolve, 8500))
      releaseFirst.resolve()

      await first
      const outcome = await secondOutcome
      if (outcome.status === 'rejected') throw outcome.error
      expect(outcome.value).toBe('second')
    } finally {
      releaseFirst.resolve()
      removeRefreshLock(accountId)
    }
  }, 12000)

  test('runs the callback, returns its value, and releases for a second acquisition', async () => {
    const accountId = 'refresh-return-value'
    removeRefreshLock(accountId)

    try {
      const first = await withRefreshLock(accountId, async () => 'first-value')
      const second = await withRefreshLock(accountId, async () => 'second-value')

      expect(first).toBe('first-value')
      expect(second).toBe('second-value')
    } finally {
      removeRefreshLock(accountId)
    }
  })

  test('allows different account ids to hold separate critical sections concurrently', async () => {
    const firstId = 'refresh-overlap-A'
    const secondId = 'refresh-overlap-B'
    removeRefreshLock(firstId)
    removeRefreshLock(secondId)

    const releaseBoth = deferred()
    const firstEntered = deferred()
    const secondEntered = deferred()
    let active = 0
    let maxConcurrent = 0

    try {
      const first = withRefreshLock(firstId, async () => {
        active++
        maxConcurrent = Math.max(maxConcurrent, active)
        firstEntered.resolve()
        await releaseBoth.promise
        active--
      })

      await firstEntered.promise

      const second = withRefreshLock(secondId, async () => {
        active++
        maxConcurrent = Math.max(maxConcurrent, active)
        secondEntered.resolve()
        await releaseBoth.promise
        active--
      })

      await secondEntered.promise
      expect(maxConcurrent).toBe(2)

      releaseBoth.resolve()
      await Promise.all([first, second])
    } finally {
      releaseBoth.resolve()
      removeRefreshLock(firstId)
      removeRefreshLock(secondId)
    }
  })

  test('serializes concurrent critical sections for the same account id', async () => {
    const accountId = 'refresh-serialized-A'
    removeRefreshLock(accountId)

    const firstEntered = deferred()
    const releaseFirst = deferred()
    let active = 0
    let maxConcurrent = 0
    const order: string[] = []

    try {
      const first = withRefreshLock(accountId, async () => {
        active++
        maxConcurrent = Math.max(maxConcurrent, active)
        order.push('first-enter')
        firstEntered.resolve()
        await releaseFirst.promise
        order.push('first-exit')
        active--
      })

      await firstEntered.promise

      const second = withRefreshLock(accountId, async () => {
        active++
        maxConcurrent = Math.max(maxConcurrent, active)
        order.push('second-enter')
        active--
      })

      await Promise.resolve()
      expect(maxConcurrent).toBe(1)
      expect(order).toEqual(['first-enter'])

      releaseFirst.resolve()
      await Promise.all([first, second])

      expect(maxConcurrent).toBe(1)
      expect(order).toEqual(['first-enter', 'first-exit', 'second-enter'])
    } finally {
      releaseFirst.resolve()
      removeRefreshLock(accountId)
    }
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

  test('usage snapshot (used/limit/overage) follows the newer lastSync, not independent max', () => {
    const existing = account({
      usedCount: 5,
      limitCount: 100,
      overageCount: 2,
      lastUsed: 10,
      lastSync: 1
    })
    const incoming = account({
      usedCount: 8,
      limitCount: 90,
      overageCount: 7,
      lastUsed: 5,
      lastSync: 20
    })
    const merged = onlyMergedAccount(mergeAccounts([existing], [incoming]))

    // AWS getUsageLimits returns one atomic usage snapshot. Independent Math.max
    // can pair fresh usedCount with stale limitCount and can keep a post-reset
    // account stuck at old high usage forever. The newer lastSync snapshot wins.
    expect(merged.usedCount).toBe(8)
    expect(merged.limitCount).toBe(90)
    expect(merged.overageCount).toBe(7)
    expect(merged.lastUsed).toBe(10)
    expect(merged.lastSync).toBe(20)
  })

  test('fresh persisted zero overage survives stale single-account upsert', async () => {
    const fixture = tempDbFixture()
    const database = createDatabase(fixture.path)

    try {
      await database.upsertAccount(
        account({
          id: 'usage-reset-single',
          usedCount: 0,
          limitCount: 10000,
          overageCount: 0,
          lastSync: 20
        })
      )

      await database.upsertAccount(
        account({
          id: 'usage-reset-single',
          usedCount: 10977,
          limitCount: 10000,
          overageCount: 977,
          lastSync: 10
        })
      )

      const rows = database.getAccounts() as UsageRow[]
      const persisted = rows.find((row) => row.id === 'usage-reset-single')
      expect(persisted).toBeDefined()
      expect(persisted?.used_count).toBe(0)
      expect(persisted?.limit_count).toBe(10000)
      expect(persisted?.overage_count).toBe(0)
      expect(persisted?.last_sync).toBe(20)
    } finally {
      database.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  test('fresh incoming zero overage wins stale persisted overage in batch upsert', async () => {
    const fixture = tempDbFixture()
    const database = createDatabase(fixture.path)

    try {
      await database.batchUpsertAccounts([
        account({
          id: 'usage-reset-batch',
          usedCount: 10977,
          limitCount: 10000,
          overageCount: 977,
          lastSync: 10
        })
      ])

      await database.batchUpsertAccounts([
        account({
          id: 'usage-reset-batch',
          usedCount: 0,
          limitCount: 10000,
          overageCount: 0,
          lastSync: 20
        })
      ])

      const rows = database.getAccounts() as UsageRow[]
      const persisted = rows.find((row) => row.id === 'usage-reset-batch')
      expect(persisted).toBeDefined()
      expect(persisted?.used_count).toBe(0)
      expect(persisted?.limit_count).toBe(10000)
      expect(persisted?.overage_count).toBe(0)
      expect(persisted?.last_sync).toBe(20)
    } finally {
      database.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  test('a permanent error on incoming forces the merged account unhealthy', () => {
    const existing = account({ isHealthy: true })
    const incoming = account({ isHealthy: false, unhealthyReason: 'HTTP_403' })
    const merged = onlyMergedAccount(mergeAccounts([existing], [incoming]))
    expect(merged.isHealthy).toBe(false)
  })

  test('an existing permanent error keeps the account unhealthy even if incoming looks fine but is not recovered', () => {
    const existing = account({ isHealthy: false, unhealthyReason: 'invalid_grant' })
    // incoming is unhealthy too (not a recovery), so the permanent flag wins.
    const incoming = account({ isHealthy: false, unhealthyReason: undefined })
    const merged = onlyMergedAccount(mergeAccounts([existing], [incoming]))
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
    const merged = onlyMergedAccount(mergeAccounts([existing], [incoming]))
    expect(merged.isHealthy).toBe(true)
    expect(merged.unhealthyReason).toBeUndefined()
    expect(merged.recoveryTime).toBeUndefined()
    expect(merged.failCount).toBe(0)
  })

  test('keeps the existing token triple when existing has a newer expiry', () => {
    const existing = account({ refreshToken: 'RE', accessToken: 'AE', expiresAt: 200 })
    const incoming = account({ refreshToken: 'RI', accessToken: 'AI', expiresAt: 100 })

    const merged = mergeAccounts([existing], [incoming])[0]!

    expect(merged.refreshToken).toBe('RE')
    expect(merged.accessToken).toBe('AE')
    expect(merged.expiresAt).toBe(200)
  })

  test('takes the incoming token triple when incoming has a newer expiry', () => {
    const existing = account({ refreshToken: 'RE', accessToken: 'AE', expiresAt: 100 })
    const incoming = account({ refreshToken: 'RI', accessToken: 'AI', expiresAt: 200 })

    const merged = mergeAccounts([existing], [incoming])[0]!

    expect(merged.refreshToken).toBe('RI')
    expect(merged.accessToken).toBe('AI')
    expect(merged.expiresAt).toBe(200)
  })

  test('never splits refresh, access, and expiresAt across different freshness winners', () => {
    const existing = account({ refreshToken: 'RE', accessToken: 'AE', expiresAt: 200 })
    const incoming = account({ refreshToken: 'RI', accessToken: 'AI', expiresAt: 100 })

    const merged = onlyMergedAccount(mergeAccounts([existing], [incoming]))

    expect(merged.refreshToken).toBe('RE')
    expect(merged.accessToken).toBe('AE')
    expect(merged.expiresAt).toBe(200)
    expectWholeTokenTripleFromOneInput(merged, existing, incoming)

    const reverseExisting = account({ refreshToken: 'RE2', accessToken: 'AE2', expiresAt: 100 })
    const reverseIncoming = account({ refreshToken: 'RI2', accessToken: 'AI2', expiresAt: 200 })

    const reverseMerged = onlyMergedAccount(mergeAccounts([reverseExisting], [reverseIncoming]))

    expect(reverseMerged.refreshToken).toBe('RI2')
    expect(reverseMerged.accessToken).toBe('AI2')
    expect(reverseMerged.expiresAt).toBe(200)
    expectWholeTokenTripleFromOneInput(reverseMerged, reverseExisting, reverseIncoming)
  })

  test('merges usage and health recovery independently from the selected token triple', () => {
    const existing = account({
      refreshToken: 'RE',
      accessToken: 'AE',
      expiresAt: 200,
      isHealthy: false,
      unhealthyReason: 'Rate limited',
      recoveryTime: Date.now() + 1000,
      failCount: 6,
      usedCount: 3
    })
    const incoming = account({
      refreshToken: 'RI',
      accessToken: 'AI',
      expiresAt: 100,
      isHealthy: true,
      failCount: 0,
      usedCount: 11
    })

    const merged = mergeAccounts([existing], [incoming])[0]!

    expect(merged.refreshToken).toBe('RE')
    expect(merged.accessToken).toBe('AE')
    expect(merged.expiresAt).toBe(200)
    expect(merged.usedCount).toBe(11)
    expect(merged.isHealthy).toBe(true)
    expect(merged.unhealthyReason).toBeUndefined()
    expect(merged.recoveryTime).toBeUndefined()
    expect(merged.failCount).toBe(0)
  })

  test('prevents a stale process batch save from overwriting a newer persisted token triple', async () => {
    const fixture = tempDbFixture()
    const firstProcess = createDatabase(fixture.path)
    const secondProcess = createDatabase(fixture.path)

    try {
      const staleCopy = account({
        id: 'A3',
        refreshToken: 'R0',
        accessToken: 'A0',
        expiresAt: 1000
      })
      await firstProcess.batchUpsertAccounts([staleCopy])

      await firstProcess.batchUpsertAccounts([
        account({ id: 'A3', refreshToken: 'R1', accessToken: 'A1', expiresAt: 2000 })
      ])

      await secondProcess.batchUpsertAccounts([staleCopy])

      const rows: AccountRow[] = firstProcess.getAccounts()
      const persisted = rows.find((row) => row.id === 'A3')
      expect(persisted).toBeDefined()
      if (!persisted) {
        throw new Error('Expected A3 to be persisted')
      }
      expect(persisted.refresh_token).toBe('R1')
      expect(persisted.access_token).toBe('A1')
      expect(persisted.expires_at).toBe(2000)
    } finally {
      firstProcess.close()
      secondProcess.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
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
