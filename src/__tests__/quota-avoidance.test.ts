import { describe, expect, test } from 'bun:test'
import { AccountManager } from '../plugin/accounts.js'
import type { AccountSelectionStrategy, ManagedAccount } from '../plugin/types.js'

type AccountOverrides = Partial<ManagedAccount> & { id: string }

function makeAccount(o: AccountOverrides): ManagedAccount {
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

function makeManager(
  accounts: ManagedAccount[],
  strategy: AccountSelectionStrategy = 'lowest-usage',
  opts?: { quotaAvoidanceEnabled?: boolean; quotaReserveThreshold?: number }
): AccountManager {
  return new AccountManager(accounts, strategy, {
    quotaAvoidanceEnabled: true,
    quotaReserveThreshold: 0.95,
    ...opts
  })
}

describe('quota-aware avoidance (multi-account)', () => {
  test('tiering: 96% account avoided in favor of 20% account', () => {
    const a = makeAccount({ id: 'A', usedCount: 96, limitCount: 100 })
    const b = makeAccount({ id: 'B', usedCount: 20, limitCount: 100 })
    for (const strategy of ['sticky', 'round-robin', 'lowest-usage'] as const) {
      const mgr = makeManager([makeAccount(a), makeAccount(b)], strategy)
      expect(mgr.getCurrentOrNext()?.id).toBe('B')
    }
  })

  test('drain fallback: all near-full still selects one (not null)', () => {
    const a = makeAccount({ id: 'A', usedCount: 96, limitCount: 100 })
    const b = makeAccount({ id: 'B', usedCount: 98, limitCount: 100 })
    const mgr = makeManager([a, b])
    const selected = mgr.getCurrentOrNext()
    expect(selected).not.toBeNull()
    expect(['A', 'B']).toContain(selected?.id ?? '')
  })

  test('used>=limit is drainable, not excluded: prefers account with room', () => {
    const a = makeAccount({ id: 'A', usedCount: 100, limitCount: 100 })
    const b = makeAccount({ id: 'B', usedCount: 30, limitCount: 100 })
    const mgr = makeManager([a, b])
    expect(mgr.getCurrentOrNext()?.id).toBe('B')
  })

  test('used>=limit for ALL still drains one (not null)', () => {
    const a = makeAccount({ id: 'A', usedCount: 100, limitCount: 100 })
    const b = makeAccount({ id: 'B', usedCount: 120, limitCount: 100 })
    const mgr = makeManager([a, b])
    const selected = mgr.getCurrentOrNext()
    expect(selected).not.toBeNull()
    expect(['A', 'B']).toContain(selected?.id ?? '')
  })

  test('limitCount=0 => ratio 0 => ample (not avoided)', () => {
    const a = makeAccount({ id: 'A', usedCount: 9999, limitCount: 0 })
    const b = makeAccount({ id: 'B', usedCount: 50, limitCount: 100 })
    const mgr = makeManager([a, b], 'lowest-usage')
    expect(mgr.getCurrentOrNext()?.id).toBe('B')
  })

  test('disabled: near-full account stays in pool (not avoided)', () => {
    const a = makeAccount({ id: 'A', usedCount: 96, limitCount: 100 })
    const b = makeAccount({ id: 'B', usedCount: 20, limitCount: 100 })
    const mgr = makeManager([a, b], 'sticky', { quotaAvoidanceEnabled: false })
    expect(mgr.getCurrentOrNext()?.id).toBe('A')
  })

  test('round-robin: 3 ample accounts yield 3 distinct consecutive picks', () => {
    const accts = [
      makeAccount({ id: 'A', usedCount: 10, limitCount: 100 }),
      makeAccount({ id: 'B', usedCount: 10, limitCount: 100 }),
      makeAccount({ id: 'C', usedCount: 10, limitCount: 100 })
    ]
    const mgr = makeManager(accts, 'round-robin')
    const picks = [
      mgr.getCurrentOrNext()?.id,
      mgr.getCurrentOrNext()?.id,
      mgr.getCurrentOrNext()?.id
    ]
    expect(new Set(picks).size).toBe(3)
  })

  test('sticky: repeated calls return the SAME account', () => {
    const accts = [
      makeAccount({ id: 'A', usedCount: 10, limitCount: 100 }),
      makeAccount({ id: 'B', usedCount: 10, limitCount: 100 })
    ]
    const mgr = makeManager(accts, 'sticky')
    const first = mgr.getCurrentOrNext()
    expect(first).not.toBeNull()
    const firstId = first?.id ?? ''
    expect(mgr.getCurrentOrNext()?.id).toBe(firstId)
    expect(mgr.getCurrentOrNext()?.id).toBe(firstId)
  })
})

describe('single-account: no avoidance, existing behavior preserved', () => {
  test('single account at 99% is still returned', () => {
    const a = makeAccount({ id: 'A', usedCount: 99, limitCount: 100 })
    const mgr = makeManager([a])
    expect(mgr.getCurrentOrNext()?.id).toBe('A')
  })

  test('single account rate-limited (future reset) returns null', () => {
    const a = makeAccount({
      id: 'A',
      usedCount: 10,
      limitCount: 100,
      rateLimitResetTime: Date.now() + 3600000
    })
    const mgr = makeManager([a])
    expect(mgr.getCurrentOrNext()).toBeNull()
  })

  test('single unhealthy account with elapsed recovery + failCount<10 is force-recovered', () => {
    const a = makeAccount({
      id: 'A',
      usedCount: 10,
      limitCount: 100,
      isHealthy: false,
      unhealthyReason: 'transient',
      recoveryTime: Date.now() - 1000,
      failCount: 3
    })
    const mgr = makeManager([a])
    const selected = mgr.getCurrentOrNext()
    expect(selected?.id).toBe('A')
    expect(selected?.isHealthy).toBe(true)
  })
})
