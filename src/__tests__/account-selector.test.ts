import { describe, expect, mock, test } from 'bun:test'
import { AccountSelector } from '../core/account/account-selector.js'
import { AccountManager } from '../plugin/accounts.js'
import type { ManagedAccount } from '../plugin/types.js'

// AccountSelector orchestrates a REAL AccountManager (in-memory arrays) plus a
// fake syncFromKiroCli and a fake AccountRepository. Assertions check real
// return values, real state transitions, and real toast side-effects. The one
// path that would sleep on a real timer overrides globalThis.setTimeout to run
// synchronously and restores it afterwards — no real timers, no flakiness.

type Variant = 'info' | 'warning' | 'success' | 'error'

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

function collectingToast(): {
  fn: (m: string, v: Variant) => void
  calls: Array<[string, Variant]>
} {
  const calls: Array<[string, Variant]> = []
  return { fn: (m, v) => calls.push([m, v]), calls }
}

const defaultConfig = {
  auto_sync_kiro_cli: true,
  account_selection_strategy: 'sticky' as const
}

function fakeRepo(
  overrides?: Partial<{ findAll: () => Promise<any[]>; invalidateCache: () => void }>
) {
  return {
    findAll: overrides?.findAll ?? mock(async () => []),
    invalidateCache: overrides?.invalidateCache ?? mock(() => {}),
    save: mock(async () => {}),
    batchSave: mock(async () => {}),
    delete: mock(async () => {}),
    findById: mock(async () => null),
    findHealthyAccounts: mock(async () => [])
  } as any
}

describe('AccountSelector.selectHealthyAccount - happy path', () => {
  test('returns a healthy account and does not toast when under 90% usage', async () => {
    const mgr = new AccountManager(
      [makeAccount({ id: 'A', usedCount: 10, limitCount: 100 })],
      'sticky'
    )
    const sync = mock(async () => {})
    const selector = new AccountSelector(mgr, defaultConfig, sync, fakeRepo())
    const toast = collectingToast()

    const acc = await selector.selectHealthyAccount(toast.fn)
    expect(acc?.id).toBe('A')
    expect(sync).toHaveBeenCalledTimes(0) // accounts already present
    expect(toast.calls).toHaveLength(0)
  })

  test('emits a warning toast when the selected account is at >=90% usage', async () => {
    const mgr = new AccountManager(
      [makeAccount({ id: 'A', usedCount: 95, limitCount: 100 })],
      'sticky'
    )
    const selector = new AccountSelector(
      mgr,
      defaultConfig,
      mock(async () => {}),
      fakeRepo()
    )
    const toast = collectingToast()

    const acc = await selector.selectHealthyAccount(toast.fn)
    expect(acc?.id).toBe('A')
    expect(toast.calls).toHaveLength(1)
    const [msg, variant] = toast.calls[0]!
    expect(variant).toBe('warning')
    expect(msg).toContain('A@example.com')
    expect(msg).toContain('%')
  })
})

describe('AccountSelector.selectHealthyAccount - empty accounts + auto-sync', () => {
  test('auto-syncs from Kiro CLI, imports the synced account, and returns it', async () => {
    const mgr = new AccountManager([], 'sticky')
    const synced = makeAccount({ id: 'SYNCED', usedCount: 1, limitCount: 100 })
    const sync = mock(async () => {})
    const repo = fakeRepo({ findAll: mock(async () => [synced]) })
    const selector = new AccountSelector(mgr, defaultConfig, sync, repo)
    const toast = collectingToast()

    const acc = await selector.selectHealthyAccount(toast.fn)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(repo.invalidateCache).toHaveBeenCalledTimes(1)
    expect(acc?.id).toBe('SYNCED')
    expect(mgr.getAccountCount()).toBe(1)
  })

  test('throws "No accounts" when auto-sync yields nothing', async () => {
    const mgr = new AccountManager([], 'sticky')
    const selector = new AccountSelector(
      mgr,
      defaultConfig,
      mock(async () => {}),
      fakeRepo({ findAll: mock(async () => []) })
    )
    await expect(selector.selectHealthyAccount(collectingToast().fn)).rejects.toThrow('No accounts')
  })

  test('does not attempt sync a second time (triedEmptySync latch)', async () => {
    const mgr = new AccountManager([], 'sticky')
    const sync = mock(async () => {})
    const selector = new AccountSelector(
      mgr,
      defaultConfig,
      sync,
      fakeRepo({ findAll: mock(async () => []) })
    )
    await expect(selector.selectHealthyAccount(collectingToast().fn)).rejects.toThrow('No accounts')
    await expect(selector.selectHealthyAccount(collectingToast().fn)).rejects.toThrow('No accounts')
    // Sync ran only on the first empty attempt.
    expect(sync).toHaveBeenCalledTimes(1)
  })

  test('throws "No accounts" without syncing when auto_sync_kiro_cli is disabled', async () => {
    const mgr = new AccountManager([], 'sticky')
    const sync = mock(async () => {})
    const selector = new AccountSelector(
      mgr,
      { auto_sync_kiro_cli: false, account_selection_strategy: 'sticky' },
      sync,
      fakeRepo()
    )
    await expect(selector.selectHealthyAccount(collectingToast().fn)).rejects.toThrow('No accounts')
    expect(sync).toHaveBeenCalledTimes(0)
  })
})

describe('AccountSelector.selectHealthyAccount - all rate-limited (wait branch)', () => {
  test('returns null and warns while all accounts wait out a near-term rate limit', async () => {
    const mgr = new AccountManager(
      [makeAccount({ id: 'A', rateLimitResetTime: Date.now() + 1000 })],
      'sticky'
    )
    const selector = new AccountSelector(
      mgr,
      defaultConfig,
      mock(async () => {}),
      fakeRepo()
    )
    const toast = collectingToast()

    const realSetTimeout = globalThis.setTimeout
    // Run the internal sleep synchronously so no real timer fires.
    globalThis.setTimeout = ((cb: (...a: any[]) => void) => {
      cb()
      return 0 as any
    }) as any
    try {
      const acc = await selector.selectHealthyAccount(toast.fn)
      expect(acc).toBeNull()
      expect(toast.calls).toHaveLength(1)
      expect(toast.calls[0]![1]).toBe('warning')
      expect(toast.calls[0]![0]).toContain('rate-limited')
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })

  test('an aborted signal interrupts the rate-limit wait', async () => {
    const mgr = new AccountManager(
      [makeAccount({ id: 'A', rateLimitResetTime: Date.now() + 1000 })],
      'sticky'
    )
    const selector = new AccountSelector(
      mgr,
      defaultConfig,
      mock(async () => {}),
      fakeRepo()
    )
    const controller = new AbortController()
    const reason = new DOMException('caller aborted', 'AbortError')
    controller.abort(reason)

    await expect(
      selector.selectHealthyAccount(collectingToast().fn, controller.signal)
    ).rejects.toBe(reason)
  })
})

describe('AccountSelector.selectHealthyAccount - circuit breaker', () => {
  test('throws the circuit-breaker error after 10 consecutive selection failures', async () => {
    // A permanently-unhealthy single account: getCurrentOrNext always returns
    // null and getMinWaitTime is 0, so each call throws "All accounts…" and
    // bumps the trip counter. The 11th call trips the breaker first.
    const mgr = new AccountManager(
      [makeAccount({ id: 'A', isHealthy: false, unhealthyReason: 'HTTP_403', failCount: 10 })],
      'sticky'
    )
    const selector = new AccountSelector(
      mgr,
      defaultConfig,
      mock(async () => {}),
      fakeRepo()
    )
    const toast = collectingToast()

    for (let i = 0; i < 10; i++) {
      await expect(selector.selectHealthyAccount(toast.fn)).rejects.toThrow(
        'All accounts are unhealthy or rate-limited'
      )
    }
    await expect(selector.selectHealthyAccount(toast.fn)).rejects.toThrow('Circuit breaker tripped')
  })
})
