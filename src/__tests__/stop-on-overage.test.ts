import { describe, expect, test } from 'bun:test'
import { AccountSelector } from '../core/account/account-selector.js'
import { AccountCache } from '../infrastructure/database/account-cache.js'
import { AccountRepository } from '../infrastructure/database/account-repository.js'
import { AccountManager } from '../plugin/accounts.js'
import { DEFAULT_CONFIG, KiroConfigSchema } from '../plugin/config/schema.js'
import type { AccountSelectionStrategy, ManagedAccount } from '../plugin/types.js'

type Variant = 'info' | 'warning' | 'success' | 'error'

type AccountOverrides = Partial<ManagedAccount> & { id: string }

function makeAccount(overrides: AccountOverrides): ManagedAccount {
  return {
    email: `${overrides.id}@example.com`,
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: `refresh-${overrides.id}`,
    accessToken: `access-${overrides.id}`,
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 0,
    limitCount: 10000,
    overageCount: 0,
    ...overrides
  }
}

function makeManager(
  accounts: ManagedAccount[],
  strategy: AccountSelectionStrategy = 'lowest-usage',
  opts: {
    stopOnOverage?: boolean
    overageThreshold?: number
  } = {}
): AccountManager {
  return new AccountManager(accounts, strategy, {
    quotaAvoidanceEnabled: true,
    quotaReserveThreshold: 0.95,
    ...opts
  })
}

function makeSelector(manager: AccountManager): AccountSelector {
  return new AccountSelector(
    manager,
    { auto_sync_kiro_cli: false, account_selection_strategy: 'lowest-usage' },
    async () => {},
    new AccountRepository(new AccountCache(60000))
  )
}

function collectingToast(): {
  fn: (message: string, variant: Variant) => void
  calls: Array<[string, Variant]>
} {
  const calls: Array<[string, Variant]> = []
  return { fn: (message, variant) => calls.push([message, variant]), calls }
}

describe('stop-on-overage config defaults', () => {
  test('defaults to stopping on any paid overage', () => {
    const parsed = KiroConfigSchema.parse({})

    expect(parsed.stop_on_overage).toBe(true)
    expect(parsed.overage_threshold).toBe(0)
    expect(DEFAULT_CONFIG.stop_on_overage).toBe(true)
    expect(DEFAULT_CONFIG.overage_threshold).toBe(0)
  })
})

describe('AccountManager stop-on-overage selection gate', () => {
  test('single-account overage is excluded instead of drained', () => {
    const manager = makeManager([makeAccount({ id: 'A', overageCount: 977 })])

    expect(manager.getCurrentOrNext()).toBeNull()
  })

  test('multi-account selection skips an overage account and selects a clean account', () => {
    const overage = makeAccount({ id: 'A', usedCount: 1, overageCount: 977 })
    const clean = makeAccount({ id: 'B', usedCount: 50, overageCount: 0 })
    const manager = makeManager([overage, clean])

    expect(manager.getCurrentOrNext()?.id).toBe('B')
  })

  test('recoverable unhealthy account in overage is not revived by the fallback path', () => {
    const manager = makeManager([
      makeAccount({
        id: 'A',
        isHealthy: false,
        unhealthyReason: 'transient network failure',
        recoveryTime: Date.now() + 3600000,
        failCount: 3,
        overageCount: 977
      })
    ])

    expect(manager.getCurrentOrNext()).toBeNull()
  })

  test('stopOnOverage disabled allows an overage account to be selected', () => {
    const manager = makeManager([makeAccount({ id: 'A', overageCount: 977 })], 'sticky', {
      stopOnOverage: false
    })

    expect(manager.getCurrentOrNext()?.id).toBe('A')
  })

  test('overageThreshold allows counts at the threshold and blocks counts above it', () => {
    const atThreshold = makeManager([makeAccount({ id: 'A', overageCount: 5 })], 'sticky', {
      overageThreshold: 5
    })
    const aboveThreshold = makeManager([makeAccount({ id: 'B', overageCount: 6 })], 'sticky', {
      overageThreshold: 5
    })

    expect(atThreshold.getCurrentOrNext()?.id).toBe('A')
    expect(aboveThreshold.getCurrentOrNext()).toBeNull()
  })
})

describe('AccountSelector all-overage hard stop', () => {
  test('single-account overage throws the paid-overage hard-stop error', async () => {
    const selector = makeSelector(makeManager([makeAccount({ id: 'A', overageCount: 977 })]))

    await expect(selector.selectHealthyAccount(collectingToast().fn)).rejects.toThrow(
      'All accounts have exceeded their free quota and entered paid overage'
    )
  })

  test('all overage accounts throw the paid-overage hard-stop error without waiting', async () => {
    const selector = makeSelector(
      makeManager([
        makeAccount({ id: 'A', overageCount: 977 }),
        makeAccount({ id: 'B', overageCount: 12 })
      ])
    )

    await expect(selector.selectHealthyAccount(collectingToast().fn)).rejects.toThrow(
      'Set "stop_on_overage": false in ~/.config/opencode/kiro-auth-plugin/kiro.json'
    )
  })

  test('a clean rate-limited account takes precedence over all-overage hard-stop', async () => {
    const selector = makeSelector(
      makeManager([
        makeAccount({ id: 'A', overageCount: 977 }),
        makeAccount({ id: 'B', overageCount: 0, rateLimitResetTime: Date.now() + 25 })
      ])
    )
    const toast = collectingToast()

    const selected = await selector.selectHealthyAccount(toast.fn)

    expect(selected).toBeNull()
    expect(toast.calls).toHaveLength(1)
    expect(toast.calls[0]?.[0]).toContain('rate-limited')
  })
})
