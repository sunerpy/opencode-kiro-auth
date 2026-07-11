import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { KiroAuthDetails, ManagedAccount } from '../plugin/types.js'

// UsageTracker imports fetchUsageLimits + updateAccountQuota directly from
// ../plugin/usage, so we control fetchUsageLimits through a mutable responder
// installed with mock.module. updateAccountQuota is kept REAL (imported via a
// cache-busting '?real' specifier) so the account-mutation path runs for real.
//
// The default responder matches the offline contract sibling suites
// (account-tombstone / placeholder-eliminate) rely on:
//   access "email-<name>" -> <name>@example.com; else -> no email.
// Each test overrides `usageResponder`; afterEach restores the default so no
// behavior leaks across files regardless of execution order.

interface UsageResult {
  usedCount: number
  limitCount: number
  email?: string
}

const siblingDefault = async (auth: { access?: string }): Promise<UsageResult> => {
  if (typeof auth.access === 'string' && auth.access.startsWith('email-')) {
    return {
      usedCount: 5,
      limitCount: 100,
      email: `${auth.access.slice('email-'.length)}@example.com`
    }
  }
  return { usedCount: 0, limitCount: 0 }
}

let usageResponder: (auth: KiroAuthDetails) => Promise<UsageResult> = siblingDefault

const realUsage = (await import(
  '../plugin/usage.js' + '?real'
)) as typeof import('../plugin/usage.js')

mock.module('../plugin/usage.js', () => ({
  fetchUsageLimits: (auth: KiroAuthDetails) => usageResponder(auth),
  updateAccountQuota: realUsage.updateAccountQuota
}))

const { UsageTracker } = await import('../core/account/usage-tracker.js')
const { AccountManager } = await import('../plugin/accounts.js')

afterEach(() => {
  usageResponder = siblingDefault
})

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

function authFor(acc: ManagedAccount): KiroAuthDetails {
  return {
    refresh: 'r',
    access: acc.accessToken,
    expires: acc.expiresAt,
    authMethod: 'idc',
    region: acc.region,
    email: acc.email
  }
}

function fakeRepo() {
  return {
    batchSave: mock(async () => {}),
    save: mock(async () => {}),
    findAll: mock(async () => []),
    invalidateCache: mock(() => {}),
    delete: mock(async () => {}),
    findById: mock(async () => null),
    findHealthyAccounts: mock(async () => [])
  } as any
}

const baseConfig = {
  usage_tracking_enabled: true,
  usage_sync_max_retries: 2
}

/** Await until a predicate holds or a bounded number of microtask turns pass. */
async function until(pred: () => boolean, turns = 100): Promise<void> {
  for (let i = 0; i < turns && !pred(); i++) {
    await Promise.resolve()
  }
}

describe('UsageTracker.syncUsage - disabled', () => {
  test('does nothing when usage tracking is disabled', async () => {
    let called = false
    usageResponder = async () => {
      called = true
      return { usedCount: 1, limitCount: 1 }
    }
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    const tracker = new UsageTracker({ ...baseConfig, usage_tracking_enabled: false }, mgr, repo)
    await tracker.syncUsage(acc, authFor(acc))
    await until(() => called, 20)
    expect(called).toBe(false)
    expect(repo.batchSave).toHaveBeenCalledTimes(0)
  })
})

describe('UsageTracker.syncUsage - success + cooldown', () => {
  test('fetches usage, updates the account quota, and persists via batchSave', async () => {
    const acc = makeAccount({ id: 'A', accessToken: 'email-alice' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    const tracker = new UsageTracker(baseConfig, mgr, repo)

    await tracker.syncUsage(acc, authFor(acc))
    await until(() => (repo.batchSave.mock.calls.length as number) > 0)

    const managed = mgr.getAccounts().find((a) => a.id === 'A')!
    expect(managed.usedCount).toBe(5)
    expect(managed.limitCount).toBe(100)
    expect(managed.email).toBe('alice@example.com')
    expect(repo.batchSave).toHaveBeenCalledTimes(1)
  })

  test('a second sync within the cooldown window is skipped', async () => {
    let calls = 0
    usageResponder = async () => {
      calls++
      return { usedCount: 5, limitCount: 100 }
    }
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    const tracker = new UsageTracker(
      { ...baseConfig, usage_sync_cooldown_ms: 60000 },
      mgr,
      fakeRepo()
    )

    await tracker.syncUsage(acc, authFor(acc))
    await until(() => calls > 0)
    expect(calls).toBe(1)

    // Immediately again -> inside cooldown -> no additional fetch.
    await tracker.syncUsage(acc, authFor(acc))
    await Promise.resolve()
    expect(calls).toBe(1)
  })

  test('a sync after the cooldown elapses fetches again', async () => {
    let calls = 0
    usageResponder = async () => {
      calls++
      return { usedCount: 5, limitCount: 100 }
    }
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    // cooldown 0 -> the elapsed check (now-last < 0) is always false, so the
    // second call is allowed once the clock advances by any amount.
    const tracker = new UsageTracker({ ...baseConfig, usage_sync_cooldown_ms: 0 }, mgr, fakeRepo())

    await tracker.syncUsage(acc, authFor(acc))
    await until(() => calls === 1)
    await tracker.syncUsage(acc, authFor(acc))
    await until(() => calls === 2)
    expect(calls).toBe(2)
  })
})

describe('UsageTracker.syncWithRetry - retry then success', () => {
  test('retries after a transient failure and then succeeds', async () => {
    let calls = 0
    usageResponder = async () => {
      calls++
      if (calls === 1) throw new Error('transient network error')
      return { usedCount: 8, limitCount: 200 }
    }
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    const tracker = new UsageTracker(baseConfig, mgr, repo)

    // The retry backoff sleeps via setTimeout; run it synchronously.
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: (...a: any[]) => void) => {
      cb()
      return 0 as any
    }) as any
    try {
      await tracker.syncUsage(acc, authFor(acc))
      await until(() => (repo.batchSave.mock.calls.length as number) > 0)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }

    expect(calls).toBe(2)
    expect(mgr.getAccounts().find((a) => a.id === 'A')!.usedCount).toBe(8)
    expect(repo.batchSave).toHaveBeenCalledTimes(1)
  })
})

describe('UsageTracker.syncWithRetry - FEATURE_NOT_SUPPORTED (no penalty)', () => {
  test('exhausts retries then swallows FEATURE_NOT_SUPPORTED without marking unhealthy', async () => {
    usageResponder = async () => {
      throw new Error('getUsageLimits: FEATURE_NOT_SUPPORTED for this profile')
    }
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    const markUnhealthySpy = mock(mgr.markUnhealthy.bind(mgr))
    ;(mgr as any).markUnhealthy = markUnhealthySpy
    const repo = fakeRepo()
    const tracker = new UsageTracker({ ...baseConfig, usage_sync_max_retries: 1 }, mgr, repo)

    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: (...a: any[]) => void) => {
      cb()
      return 0 as any
    }) as any
    try {
      await tracker.syncUsage(acc, authFor(acc))
      // Give the retry chain time to resolve.
      await until(() => false, 50)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }

    expect(markUnhealthySpy).toHaveBeenCalledTimes(0)
    expect(mgr.getAccounts().find((a) => a.id === 'A')!.isHealthy).toBe(true)
  })
})

describe('UsageTracker.syncWithRetry - 403 marks unhealthy', () => {
  test('a 403 "invalid bearer token" error after retries calls markUnhealthy and saves', async () => {
    usageResponder = async () => {
      throw new Error('Status: 403 invalid bearer token')
    }
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    const tracker = new UsageTracker({ ...baseConfig, usage_sync_max_retries: 1 }, mgr, repo)

    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: (...a: any[]) => void) => {
      cb()
      return 0 as any
    }) as any
    try {
      await tracker.syncUsage(acc, authFor(acc))
      await until(() => (repo.save.mock.calls.length as number) > 0, 100)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }

    const managed = mgr.getAccounts().find((a) => a.id === 'A')!
    // The message matches the 403/invalid/bearer branch -> markUnhealthy(account, msg)
    // + repository.save. isPermanentError("Status: 403 invalid bearer token") is
    // false (no HTTP_403 / Invalid-refresh-token marker), so it takes the
    // transient path: unhealthyReason recorded, failCount incremented, still healthy.
    expect(managed.unhealthyReason).toBe('Status: 403 invalid bearer token')
    expect(managed.failCount).toBe(1)
    expect(managed.isHealthy).toBe(true)
    expect(repo.save).toHaveBeenCalledTimes(1)
  })

  test('a permanent HTTP_403 error after retries marks the account permanently unhealthy', async () => {
    usageResponder = async () => {
      throw new Error('HTTP_403 invalid bearer token denied')
    }
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    const tracker = new UsageTracker({ ...baseConfig, usage_sync_max_retries: 1 }, mgr, repo)

    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: (...a: any[]) => void) => {
      cb()
      return 0 as any
    }) as any
    try {
      await tracker.syncUsage(acc, authFor(acc))
      await until(() => (repo.save.mock.calls.length as number) > 0, 100)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }

    const managed = mgr.getAccounts().find((a) => a.id === 'A')!
    expect(managed.isHealthy).toBe(false)
    expect(managed.failCount).toBe(10)
    expect(repo.save).toHaveBeenCalledTimes(1)
  })
})
