import { describe, expect, test } from 'bun:test'
import { AccountManager } from '../plugin/accounts.js'
import type { ManagedAccount } from '../plugin/types.js'

// These tests exercise AccountManager's in-memory state transitions. The
// class also fires DB writes as fire-and-forget promises; the suite's
// setup.ts preload isolates kiroDb to a throwaway temp dir, so those writes
// are harmless and never touch the developer's real kiro.db. Every assertion
// below reads the synchronously-mutated in-memory account object.

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

describe('AccountManager.markRateLimited', () => {
  test('sets rateLimitResetTime to now+ms on the matching account', () => {
    const a = makeAccount({ id: 'A' })
    const mgr = new AccountManager([a], 'sticky')
    const before = Date.now()
    mgr.markRateLimited(a, 5000)
    const acc = mgr.getAccounts().find((x) => x.id === 'A')!
    expect(acc.rateLimitResetTime).toBeGreaterThanOrEqual(before + 5000)
    expect(acc.rateLimitResetTime).toBeLessThanOrEqual(Date.now() + 5000)
  })

  test('is a no-op when the account id is not managed', () => {
    const a = makeAccount({ id: 'A' })
    const mgr = new AccountManager([a], 'sticky')
    const ghost = makeAccount({ id: 'GHOST' })
    mgr.markRateLimited(ghost, 5000)
    expect(mgr.getAccounts().find((x) => x.id === 'A')!.rateLimitResetTime).toBe(0)
  })
})

describe('AccountManager.markUnhealthy', () => {
  test('transient reason increments failCount without going unhealthy below 10', () => {
    const a = makeAccount({ id: 'A', failCount: 0 })
    const mgr = new AccountManager([a], 'sticky')
    mgr.markUnhealthy(a, 'transient network blip')
    const acc = mgr.getAccounts().find((x) => x.id === 'A')!
    expect(acc.failCount).toBe(1)
    expect(acc.isHealthy).toBe(true)
    expect(acc.unhealthyReason).toBe('transient network blip')
    expect(acc.recoveryTime).toBeUndefined()
  })

  test('transient reason at failCount 9 -> 10 flips unhealthy and sets recoveryTime', () => {
    const a = makeAccount({ id: 'A', failCount: 9 })
    const mgr = new AccountManager([a], 'sticky')
    const recovery = Date.now() + 123456
    mgr.markUnhealthy(a, 'transient', recovery)
    const acc = mgr.getAccounts().find((x) => x.id === 'A')!
    expect(acc.failCount).toBe(10)
    expect(acc.isHealthy).toBe(false)
    expect(acc.recoveryTime).toBe(recovery)
  })

  test('transient reason at failCount 9 with no recovery arg defaults to +1h', () => {
    const a = makeAccount({ id: 'A', failCount: 9 })
    const mgr = new AccountManager([a], 'sticky')
    const before = Date.now()
    mgr.markUnhealthy(a, 'transient')
    const acc = mgr.getAccounts().find((x) => x.id === 'A')!
    expect(acc.recoveryTime!).toBeGreaterThanOrEqual(before + 3600000)
    expect(acc.recoveryTime!).toBeLessThanOrEqual(Date.now() + 3600000)
  })

  test('permanent reason immediately marks unhealthy with failCount 10 and no recoveryTime', () => {
    const a = makeAccount({ id: 'A', failCount: 2, recoveryTime: 999 })
    const mgr = new AccountManager([a], 'sticky')
    mgr.markUnhealthy(a, 'Invalid refresh token provided')
    const acc = mgr.getAccounts().find((x) => x.id === 'A')!
    expect(acc.failCount).toBe(10)
    expect(acc.isHealthy).toBe(false)
    expect(acc.unhealthyReason).toBe('Invalid refresh token provided')
    expect(acc.recoveryTime).toBeUndefined()
  })

  test('is a no-op when the account id is not managed', () => {
    const a = makeAccount({ id: 'A' })
    const mgr = new AccountManager([a], 'sticky')
    mgr.markUnhealthy(makeAccount({ id: 'GHOST' }), 'HTTP_403')
    expect(mgr.getAccounts().find((x) => x.id === 'A')!.failCount).toBe(0)
  })
})

describe('AccountManager.updateUsage', () => {
  test('updates counts + email and resets health for a transient-unhealthy account', () => {
    const a = makeAccount({
      id: 'A',
      failCount: 4,
      isHealthy: false,
      unhealthyReason: 'transient',
      recoveryTime: Date.now() + 1000
    })
    const mgr = new AccountManager([a], 'sticky')
    mgr.updateUsage('A', { usedCount: 42, limitCount: 100, email: 'new@example.com' })
    const acc = mgr.getAccounts().find((x) => x.id === 'A')!
    expect(acc.usedCount).toBe(42)
    expect(acc.limitCount).toBe(100)
    expect(acc.email).toBe('new@example.com')
    expect(acc.failCount).toBe(0)
    expect(acc.isHealthy).toBe(true)
    expect(acc.unhealthyReason).toBeUndefined()
    expect(acc.recoveryTime).toBeUndefined()
  })

  test('does NOT resurrect a permanently-unhealthy account', () => {
    const a = makeAccount({
      id: 'A',
      failCount: 10,
      isHealthy: false,
      unhealthyReason: 'HTTP_403'
    })
    const mgr = new AccountManager([a], 'sticky')
    mgr.updateUsage('A', { usedCount: 5, limitCount: 100 })
    const acc = mgr.getAccounts().find((x) => x.id === 'A')!
    expect(acc.usedCount).toBe(5)
    expect(acc.isHealthy).toBe(false)
    expect(acc.unhealthyReason).toBe('HTTP_403')
  })

  test('is a no-op for an unknown id', () => {
    const a = makeAccount({ id: 'A', usedCount: 1 })
    const mgr = new AccountManager([a], 'sticky')
    mgr.updateUsage('UNKNOWN', { usedCount: 99, limitCount: 100 })
    expect(mgr.getAccounts().find((x) => x.id === 'A')!.usedCount).toBe(1)
  })
})

describe('AccountManager.addAccount / removeAccount', () => {
  test('addAccount appends a new id and updates an existing one in place', () => {
    const a = makeAccount({ id: 'A', usedCount: 1 })
    const mgr = new AccountManager([a], 'sticky')
    expect(mgr.getAccountCount()).toBe(1)

    mgr.addAccount(makeAccount({ id: 'B' }))
    expect(mgr.getAccountCount()).toBe(2)

    mgr.addAccount(makeAccount({ id: 'A', usedCount: 77 }))
    expect(mgr.getAccountCount()).toBe(2) // still 2, updated in place
    expect(mgr.getAccounts().find((x) => x.id === 'A')!.usedCount).toBe(77)
  })

  test('removeAccount drops the account from the in-memory view', () => {
    const a = makeAccount({ id: 'A' })
    const b = makeAccount({ id: 'B' })
    const mgr = new AccountManager([a, b], 'round-robin')
    mgr.removeAccount(a)
    expect(mgr.getAccountCount()).toBe(1)
    expect(mgr.getAccounts().find((x) => x.id === 'A')).toBeUndefined()
    expect(mgr.getAccounts().find((x) => x.id === 'B')).toBeDefined()
  })

  test('removeAccount on an unmanaged id leaves the pool unchanged', () => {
    const a = makeAccount({ id: 'A' })
    const mgr = new AccountManager([a], 'sticky')
    mgr.removeAccount(makeAccount({ id: 'GHOST' }))
    expect(mgr.getAccountCount()).toBe(1)
  })

  test('getAccounts returns a defensive copy (mutating it does not affect the manager)', () => {
    const a = makeAccount({ id: 'A' })
    const mgr = new AccountManager([a], 'sticky')
    const copy = mgr.getAccounts()
    copy.pop()
    expect(mgr.getAccountCount()).toBe(1)
  })
})

describe('AccountManager.getMinWaitTime', () => {
  test('returns the smallest positive time until a rate-limit reset', () => {
    const now = Date.now()
    const a = makeAccount({ id: 'A', rateLimitResetTime: now + 10000 })
    const b = makeAccount({ id: 'B', rateLimitResetTime: now + 3000 })
    const c = makeAccount({ id: 'C', rateLimitResetTime: 0 }) // no reset
    const mgr = new AccountManager([a, b, c], 'sticky')
    const wait = mgr.getMinWaitTime()
    // b is the nearest; allow a few ms of clock drift.
    expect(wait).toBeGreaterThan(2000)
    expect(wait).toBeLessThanOrEqual(3000)
  })

  test('returns 0 when no account has a future reset', () => {
    const a = makeAccount({ id: 'A', rateLimitResetTime: 0 })
    const b = makeAccount({ id: 'B', rateLimitResetTime: Date.now() - 5000 })
    const mgr = new AccountManager([a, b], 'sticky')
    expect(mgr.getMinWaitTime()).toBe(0)
  })
})

describe('AccountManager toast debounce', () => {
  test('shouldShowToast is true first, then false within the debounce window', () => {
    const mgr = new AccountManager([makeAccount({ id: 'A' })], 'sticky')
    expect(mgr.shouldShowToast(10000)).toBe(true)
    expect(mgr.shouldShowToast(10000)).toBe(false)
  })

  test('shouldShowToast becomes true again once the debounce elapses (debounce=0)', () => {
    const mgr = new AccountManager([makeAccount({ id: 'A' })], 'sticky')
    expect(mgr.shouldShowToast(0)).toBe(true)
    // debounce 0 => any elapsed time (>=0, and time advanced) permits another.
    expect(mgr.shouldShowToast(-1)).toBe(true)
  })

  test('shouldShowUsageToast tracks its own independent timer', () => {
    const mgr = new AccountManager([makeAccount({ id: 'A' })], 'sticky')
    expect(mgr.shouldShowUsageToast(10000)).toBe(true)
    expect(mgr.shouldShowUsageToast(10000)).toBe(false)
    // Independent from shouldShowToast: the usage timer does not affect it.
    expect(mgr.shouldShowToast(10000)).toBe(true)
  })
})

describe('AccountManager.updateFromAuth', () => {
  test('applies refreshed auth (access/expires/email/refresh parts) and heals the account', () => {
    const a = makeAccount({
      id: 'A',
      failCount: 5,
      isHealthy: false,
      unhealthyReason: 'transient',
      recoveryTime: Date.now() + 1000
    })
    const mgr = new AccountManager([a], 'sticky')
    const newExpires = Date.now() + 7200000
    mgr.updateFromAuth(a, {
      refresh: 'new-refresh|new-cid|new-cs|idc',
      access: 'new-access-token',
      expires: newExpires,
      authMethod: 'idc',
      region: 'us-east-1',
      email: 'updated@example.com'
    })
    const acc = mgr.getAccounts().find((x) => x.id === 'A')!
    expect(acc.accessToken).toBe('new-access-token')
    expect(acc.expiresAt).toBe(newExpires)
    expect(acc.email).toBe('updated@example.com')
    expect(acc.refreshToken).toBe('new-refresh')
    expect(acc.clientId).toBe('new-cid')
    expect(acc.failCount).toBe(0)
    expect(acc.isHealthy).toBe(true)
    expect(acc.unhealthyReason).toBeUndefined()
    expect(acc.recoveryTime).toBeUndefined()
  })

  test('is a no-op for an unmanaged id', () => {
    const a = makeAccount({ id: 'A', accessToken: 'orig' })
    const mgr = new AccountManager([a], 'sticky')
    mgr.updateFromAuth(makeAccount({ id: 'GHOST' }), {
      refresh: 'r|c|s|idc',
      access: 'x',
      expires: Date.now(),
      authMethod: 'idc',
      region: 'us-east-1'
    })
    expect(mgr.getAccounts().find((x) => x.id === 'A')!.accessToken).toBe('orig')
  })
})

describe('AccountManager.toAuthDetails', () => {
  test('encodes an idc account into KiroAuthDetails with a round-trippable refresh', () => {
    const a = makeAccount({
      id: 'A',
      clientId: 'cid',
      clientSecret: 'cs',
      profileArn: 'arn-x',
      refreshToken: 'rt'
    })
    const mgr = new AccountManager([a], 'sticky')
    const auth = mgr.toAuthDetails(a)
    expect(auth.access).toBe('access-A')
    expect(auth.authMethod).toBe('idc')
    expect(auth.region).toBe('us-east-1')
    expect(auth.profileArn).toBe('arn-x')
    expect(auth.email).toBe('A@example.com')
    // refresh encodes as `${refreshToken}|${clientId}|${clientSecret}|idc`
    expect(auth.refresh).toBe('rt|cid|cs|idc')
  })
})

describe('AccountManager.getCurrentOrNext force-recover fallback', () => {
  test('recovers the lowest-usage transient-unhealthy account when no candidate is available', () => {
    // Both unhealthy & transient; recoveryTime in the FUTURE so the normal
    // available-filter rejects them, forcing the fallback branch.
    const future = Date.now() + 3600000
    const a = makeAccount({
      id: 'A',
      isHealthy: false,
      unhealthyReason: 'transient',
      recoveryTime: future,
      failCount: 3,
      usedCount: 90
    })
    const b = makeAccount({
      id: 'B',
      isHealthy: false,
      unhealthyReason: 'transient',
      recoveryTime: future,
      failCount: 3,
      usedCount: 10
    })
    const mgr = new AccountManager([a, b], 'lowest-usage')
    const selected = mgr.getCurrentOrNext()
    // Fallback picks the lowest-usage recoverable account and heals it.
    expect(selected?.id).toBe('B')
    expect(selected?.isHealthy).toBe(true)
    expect(selected?.unhealthyReason).toBeUndefined()
    expect(selected?.recoveryTime).toBeUndefined()
  })

  test('returns null when the only account is permanently unhealthy (no fallback)', () => {
    const a = makeAccount({
      id: 'A',
      isHealthy: false,
      unhealthyReason: 'HTTP_403',
      failCount: 10
    })
    const mgr = new AccountManager([a], 'sticky')
    expect(mgr.getCurrentOrNext()).toBeNull()
  })

  test('selecting increments usedCount and stamps lastUsed', () => {
    const a = makeAccount({ id: 'A', usedCount: 5 })
    const mgr = new AccountManager([a], 'sticky')
    const before = Date.now()
    const sel = mgr.getCurrentOrNext()
    expect(sel?.usedCount).toBe(6)
    expect(sel?.lastUsed!).toBeGreaterThanOrEqual(before)
  })
})
