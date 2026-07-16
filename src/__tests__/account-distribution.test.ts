import { describe, expect, spyOn, test } from 'bun:test'
import { AccountManager } from '../plugin/accounts.js'
import { DEFAULT_CONFIG, KiroConfigSchema } from '../plugin/config/schema.js'
import * as logger from '../plugin/logger.js'
import { kiroDb } from '../plugin/storage/sqlite.js'
import type { ManagedAccount } from '../plugin/types.js'

type AccountOverrides = Partial<ManagedAccount> & { id: string }

function makeAccount(overrides: AccountOverrides): ManagedAccount {
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
    usedCount: 0,
    limitCount: 10_000,
    overageCount: 0,
    ...overrides
  }
}

function makeManager(
  accounts: ManagedAccount[],
  strategy: 'sticky' | 'round-robin' | 'lowest-usage' = 'sticky',
  opts: { startIndex?: number; perRequestSpread?: boolean } = {}
): AccountManager {
  return new AccountManager(accounts, strategy, {
    quotaAvoidanceEnabled: false,
    ...opts
  })
}

function accountRow(account: ManagedAccount): Record<string, unknown> {
  return {
    id: account.id,
    email: account.email,
    auth_method: account.authMethod,
    region: account.region,
    oidc_region: account.oidcRegion ?? null,
    client_id: account.clientId ?? null,
    client_secret: account.clientSecret ?? null,
    profile_arn: account.profileArn ?? null,
    start_url: account.startUrl ?? null,
    refresh_token: account.refreshToken,
    access_token: account.accessToken,
    expires_at: account.expiresAt,
    rate_limit_reset: account.rateLimitResetTime,
    is_healthy: account.isHealthy ? 1 : 0,
    unhealthy_reason: account.unhealthyReason ?? null,
    recovery_time: account.recoveryTime ?? null,
    fail_count: account.failCount,
    last_used: account.lastUsed ?? 0,
    used_count: account.usedCount ?? 0,
    limit_count: account.limitCount ?? 0,
    overage_count: account.overageCount ?? 0,
    last_sync: account.lastSync ?? 0
  }
}

describe('AccountManager cross-process start index', () => {
  test('sticky first pick uses startIndex in stable id order', () => {
    const accounts = ['e', 'a', 'd', 'b', 'c'].map((id) => makeAccount({ id }))
    const manager = makeManager(accounts, 'sticky', { startIndex: 2 })

    expect(manager.getCurrentOrNext()?.id).toBe('c')
  })

  test('sticky circular scan skips a blocked offset without collapsing to candidatePool[0]', () => {
    const accounts = [
      makeAccount({ id: 'e' }),
      makeAccount({ id: 'a' }),
      makeAccount({ id: 'c', isHealthy: false, unhealthyReason: 'HTTP_403', failCount: 10 }),
      makeAccount({ id: 'b' }),
      makeAccount({ id: 'd' })
    ]
    const manager = makeManager(accounts, 'sticky', { startIndex: 2 })

    expect(manager.getCurrentOrNext()?.id).toBe('d')
  })

  test('round-robin starts from startIndex and then advances circularly', () => {
    const accounts = ['a', 'b', 'c', 'd'].map((id) => makeAccount({ id }))
    const manager = makeManager(accounts, 'round-robin', { startIndex: 2 })

    expect(manager.getCurrentOrNext()?.id).toBe('c')
    expect(manager.getCurrentOrNext()?.id).toBe('d')
    expect(manager.getCurrentOrNext()?.id).toBe('a')
  })

  test('lowest-usage uses startIndex only to break equal-usage ties', () => {
    const accounts = ['d', 'a', 'c', 'b'].map((id) => makeAccount({ id, usedCount: 5 }))
    const tied = makeManager(accounts, 'lowest-usage', { startIndex: 2 })
    const genuinelyLower = makeManager(
      [
        makeAccount({ id: 'a', usedCount: 7 }),
        makeAccount({ id: 'b', usedCount: 1 }),
        makeAccount({ id: 'c', usedCount: 7 })
      ],
      'lowest-usage',
      { startIndex: 2 }
    )

    expect(tied.getCurrentOrNext()?.id).toBe('c')
    expect(genuinelyLower.getCurrentOrNext()?.id).toBe('b')
  })

  test('counter failure warns and falls back to start index zero without crashing startup', async () => {
    const accounts = spyOn(kiroDb, 'getAccounts').mockReturnValue([
      accountRow(makeAccount({ id: 'b' })),
      accountRow(makeAccount({ id: 'a' }))
    ])
    const counter = spyOn(kiroDb, 'nextAssignmentIndex').mockRejectedValue(
      new Error('counter unavailable')
    )
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})

    try {
      const manager = await AccountManager.loadFromDisk('sticky', {
        quotaAvoidanceEnabled: false
      })

      expect(manager.getCurrentOrNext()?.id).toBe('a')
      expect(counter).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
      counter.mockRestore()
      accounts.mockRestore()
    }
  })

  test('distributeAcrossProcesses false skips the counter and keeps legacy start index zero', async () => {
    const accounts = spyOn(kiroDb, 'getAccounts').mockReturnValue([
      accountRow(makeAccount({ id: 'a' })),
      accountRow(makeAccount({ id: 'b' }))
    ])
    const counter = spyOn(kiroDb, 'nextAssignmentIndex').mockResolvedValue(1)

    try {
      const manager = await AccountManager.loadFromDisk('sticky', {
        distributeAcrossProcesses: false,
        quotaAvoidanceEnabled: false
      })

      expect(manager.getCurrentOrNext()?.id).toBe('a')
      expect(counter).not.toHaveBeenCalled()
    } finally {
      counter.mockRestore()
      accounts.mockRestore()
    }
  })
})

describe('AccountManager per-request spread', () => {
  test('picks the live lowest-used account on every request regardless of sticky strategy', () => {
    const accounts = ['a', 'b', 'c'].map((id) => makeAccount({ id }))
    const manager = makeManager(accounts, 'sticky', { perRequestSpread: true })

    const picks = [
      manager.getCurrentOrNext()?.id,
      manager.getCurrentOrNext()?.id,
      manager.getCurrentOrNext()?.id
    ]

    expect(picks).toEqual(['a', 'b', 'c'])
  })

  test('still excludes unhealthy, rate-limited, and overage-blocked accounts', () => {
    const manager = new AccountManager(
      [
        makeAccount({ id: 'a', isHealthy: false, unhealthyReason: 'HTTP_403', failCount: 10 }),
        makeAccount({ id: 'b', rateLimitResetTime: Date.now() + 3_600_000 }),
        makeAccount({ id: 'c', overageCount: 1 }),
        makeAccount({ id: 'd', usedCount: 9 })
      ],
      'sticky',
      { perRequestSpread: true, quotaAvoidanceEnabled: false }
    )

    expect(manager.getCurrentOrNext()?.id).toBe('d')
  })

  test('defaults keep distribution enabled and per-request spread disabled', () => {
    const parsed = KiroConfigSchema.parse({})
    const manager = makeManager([makeAccount({ id: 'a' }), makeAccount({ id: 'b' })], 'sticky', {
      startIndex: 0
    })

    expect(parsed.distribute_across_processes).toBe(true)
    expect(parsed.per_request_spread).toBe(false)
    expect(DEFAULT_CONFIG.distribute_across_processes).toBe(true)
    expect(DEFAULT_CONFIG.per_request_spread).toBe(false)
    expect(manager.getCurrentOrNext()?.id).toBe('a')
    expect(manager.getCurrentOrNext()?.id).toBe('a')
  })
})
