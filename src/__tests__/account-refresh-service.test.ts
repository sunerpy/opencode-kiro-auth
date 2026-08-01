import { describe, expect, mock, test } from 'bun:test'
import type { KiroAuthDetails, ManagedAccount } from '../plugin/types.js'

type UsageSnapshot = {
  usedCount: number
  limitCount: number
  overageCount: number
  email?: string
}

type RefreshIfNeeded = (
  account: ManagedAccount,
  auth: KiroAuthDetails,
  showToast: (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void
) => Promise<{ account: ManagedAccount; shouldContinue: boolean }>

const CONFIG = {
  refresh_all_cooldown_ms: 60_000,
  refresh_all_deadline_ms: 5_000,
  token_expiry_buffer_ms: 300_000
}

function makeAccount(overrides: Partial<ManagedAccount> & { id: string }): ManagedAccount {
  return {
    email: `${overrides.id}@example.com`,
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: `refresh-${overrides.id}`,
    accessToken: `access-${overrides.id}`,
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 10,
    limitCount: 100,
    ...overrides
  }
}

function makeManager(accounts: ManagedAccount[]) {
  return {
    getAccounts: (): ManagedAccount[] => [...accounts],
    toAuthDetails: (account: ManagedAccount): KiroAuthDetails => ({
      refresh: account.refreshToken,
      access: account.accessToken,
      expires: account.expiresAt,
      authMethod: account.authMethod,
      region: account.region,
      oidcRegion: account.oidcRegion,
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      email: account.email,
      profileArn: account.profileArn
    }),
    updateUsage: (id: string, usage: UsageSnapshot & { lastSync: number }): void => {
      const account = accounts.find((candidate) => candidate.id === id)
      if (!account) return
      account.usedCount = usage.usedCount
      account.limitCount = usage.limitCount
      account.overageCount = usage.overageCount
      account.lastSync = usage.lastSync
      if (usage.email) account.email = usage.email
    }
  }
}

function makeTokenRefresher(implementation?: RefreshIfNeeded) {
  const refreshIfNeeded = mock<RefreshIfNeeded>(
    implementation ?? (async (account) => ({ account, shouldContinue: false }))
  )
  return { tokenRefresher: { refreshIfNeeded }, refreshIfNeeded }
}

function availableLock() {
  return mock(async () => mock(async () => {}))
}

function usage(value: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return { usedCount: 20, limitCount: 100, overageCount: 0, ...value }
}

describe('AccountRefreshService', () => {
  test('joins concurrent refreshAll calls into one pass over the accounts', async () => {
    const { AccountRefreshService } = await import('../core/account/account-refresh-service.js')
    const accounts = [
      makeAccount({ id: 'single-flight-A' }),
      makeAccount({ id: 'single-flight-B' })
    ]
    let releaseFetch: (() => void) | undefined
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    const fetchUsageLimits = mock(async () => {
      await fetchGate
      return usage()
    })
    const { tokenRefresher } = makeTokenRefresher()
    const service = new AccountRefreshService(CONFIG, makeManager(accounts), tokenRefresher, {
      fetchUsageLimits,
      tryAcquireKeepAliveLock: availableLock()
    })

    const first = service.refreshAll({ force: true })
    await Promise.resolve()
    const second = service.refreshAll({ force: true })
    expect(second).toBe(first)
    releaseFetch?.()
    await Promise.all([first, second])

    expect(fetchUsageLimits).toHaveBeenCalledTimes(2)
  })

  test('forced refresh does not join an automatic run that skips for lock contention', async () => {
    const { AccountRefreshService } = await import('../core/account/account-refresh-service.js')
    const account = makeAccount({ id: 'force-compatibility' })
    let announceAutomaticLockAttempt: (() => void) | undefined
    const automaticLockAttempted = new Promise<void>((resolve) => {
      announceAutomaticLockAttempt = resolve
    })
    let finishAutomaticLockAttempt: (() => void) | undefined
    const automaticLockResult = new Promise<null>((resolve) => {
      finishAutomaticLockAttempt = () => resolve(null)
    })
    let lockAttempts = 0
    const tryAcquireKeepAliveLock = mock(async () => {
      lockAttempts++
      if (lockAttempts === 1) {
        announceAutomaticLockAttempt?.()
        return automaticLockResult
      }
      return mock(async () => {})
    })
    const fetchUsageLimits = mock(async () => usage({ usedCount: 64 }))
    const { tokenRefresher } = makeTokenRefresher()
    const service = new AccountRefreshService(CONFIG, makeManager([account]), tokenRefresher, {
      fetchUsageLimits,
      tryAcquireKeepAliveLock
    })

    const automatic = service.refreshAll({ force: false })
    await automaticLockAttempted
    const forced = service.refreshAll({ force: true })
    finishAutomaticLockAttempt?.()
    const [automaticSummary, forcedSummary] = await Promise.all([automatic, forced])

    expect(automaticSummary.skippedReason).toBe('lock_unavailable')
    expect(forcedSummary.skippedReason).toBeUndefined()
    expect(forcedSummary.usageUpdated).toBe(1)
    expect(fetchUsageLimits).toHaveBeenCalledTimes(1)
  })

  test('cooldown skips automatic refresh while force bypasses it', async () => {
    const { AccountRefreshService } = await import('../core/account/account-refresh-service.js')
    const account = makeAccount({ id: 'cooldown' })
    const fetchUsageLimits = mock(async () => usage())
    const { tokenRefresher } = makeTokenRefresher()
    const service = new AccountRefreshService(CONFIG, makeManager([account]), tokenRefresher, {
      fetchUsageLimits,
      tryAcquireKeepAliveLock: availableLock(),
      now: () => 1_000_000
    })

    await service.refreshAll({ force: false })
    const skipped = await service.refreshAll({ force: false })
    expect(skipped.skippedReason).toBe('cooldown')
    expect(fetchUsageLimits).toHaveBeenCalledTimes(1)

    const forced = await service.refreshAll({ force: true })
    expect(forced.skippedReason).toBeUndefined()
    expect(fetchUsageLimits).toHaveBeenCalledTimes(2)
  })

  test('lock contention skips automatic refresh but manual refresh proceeds without the lock', async () => {
    const { AccountRefreshService } = await import('../core/account/account-refresh-service.js')
    const account = makeAccount({ id: 'lock-contention' })
    const fetchUsageLimits = mock(async () => usage())
    const { tokenRefresher } = makeTokenRefresher()
    const service = new AccountRefreshService(CONFIG, makeManager([account]), tokenRefresher, {
      fetchUsageLimits,
      tryAcquireKeepAliveLock: mock(async () => null)
    })

    const automatic = await service.refreshAll({ force: false })
    expect(automatic.skippedReason).toBe('lock_unavailable')
    expect(fetchUsageLimits).toHaveBeenCalledTimes(0)

    const manual = await service.refreshAll({ force: true })
    expect(manual.skippedReason).toBeUndefined()
    expect(manual.proceededWithoutLock).toBe(true)
    expect(fetchUsageLimits).toHaveBeenCalledTimes(1)
  })

  test('deadline resolves a hung usage fetch and reports the timeout', async () => {
    const { AccountRefreshService } = await import('../core/account/account-refresh-service.js')
    const account = makeAccount({ id: 'deadline' })
    const fetchUsageLimits = mock(
      async (): Promise<UsageSnapshot> => new Promise<UsageSnapshot>(() => {})
    )
    const { tokenRefresher } = makeTokenRefresher()
    const service = new AccountRefreshService(CONFIG, makeManager([account]), tokenRefresher, {
      fetchUsageLimits,
      tryAcquireKeepAliveLock: availableLock()
    })
    const startedAt = Date.now()

    const summary = await service.refreshAll({ force: true, deadlineMs: 20 })

    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(summary.timedOut).toBe(true)
    expect(summary.failed).toBe(1)
    expect(summary.accounts[0]?.usageStatus).toBe('timeout')
  })

  test('manual refresh applies its default deadline to a hung usage fetch', async () => {
    const { AccountRefreshService } = await import('../core/account/account-refresh-service.js')
    const account = makeAccount({ id: 'manual-deadline' })
    const fetchUsageLimits = mock(
      async (): Promise<UsageSnapshot> => new Promise<UsageSnapshot>(() => {})
    )
    const { tokenRefresher } = makeTokenRefresher()
    const service = new AccountRefreshService(
      { ...CONFIG, refresh_all_deadline_ms: 10 },
      makeManager([account]),
      tokenRefresher,
      {
        fetchUsageLimits,
        tryAcquireKeepAliveLock: availableLock()
      }
    )

    const result = await Promise.race([
      service.refreshAll({ force: true }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250))
    ])

    expect(result?.timedOut).toBe(true)
    expect(result?.failed).toBe(1)
    expect(result?.accounts[0]?.usageStatus).toBe('timeout')
  })

  test('fresh token is not renewed while usage is always fetched', async () => {
    const { AccountRefreshService } = await import('../core/account/account-refresh-service.js')
    const account = makeAccount({ id: 'fresh-token', expiresAt: Date.now() + 3_600_000 })
    const fetchUsageLimits = mock(async () => usage({ usedCount: 42 }))
    const { tokenRefresher, refreshIfNeeded } = makeTokenRefresher()
    const service = new AccountRefreshService(CONFIG, makeManager([account]), tokenRefresher, {
      fetchUsageLimits,
      tryAcquireKeepAliveLock: availableLock()
    })

    const summary = await service.refreshAll({ force: true })

    expect(refreshIfNeeded).toHaveBeenCalledTimes(0)
    expect(fetchUsageLimits).toHaveBeenCalledTimes(1)
    expect(summary.tokenRenewed).toBe(0)
    expect(summary.usageUpdated).toBe(1)
    expect(summary.accounts[0]?.tokenStatus).toBe('not_needed')
    expect(account.usedCount).toBe(42)
  })

  test('unhealthy permanent-error account skips token refresh but reports it while fetching usage', async () => {
    const { AccountRefreshService } = await import('../core/account/account-refresh-service.js')
    const account = makeAccount({
      id: 'permanent',
      expiresAt: Date.now() - 1,
      isHealthy: false,
      unhealthyReason: 'invalid_grant',
      failCount: 10
    })
    const fetchUsageLimits = mock(async () => usage({ usedCount: 55 }))
    const { tokenRefresher, refreshIfNeeded } = makeTokenRefresher()
    const service = new AccountRefreshService(CONFIG, makeManager([account]), tokenRefresher, {
      fetchUsageLimits,
      tryAcquireKeepAliveLock: availableLock()
    })

    const summary = await service.refreshAll({ force: true })

    expect(refreshIfNeeded).toHaveBeenCalledTimes(0)
    expect(fetchUsageLimits).toHaveBeenCalledTimes(1)
    expect(summary.accounts[0]?.tokenStatus).toBe('skipped_unhealthy')
    expect(summary.accounts[0]?.error).toContain('re-login')
    expect(summary.failed).toBe(1)
  })
})
