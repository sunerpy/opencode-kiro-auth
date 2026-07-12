import { afterEach, describe, expect, mock, test } from 'bun:test'
import { TokenRefresher } from '../core/auth/token-refresher.js'
import { AccountCache } from '../infrastructure/database/account-cache.js'
import { AccountRepository } from '../infrastructure/database/account-repository.js'
import { encodeRefreshToken } from '../kiro/auth.js'
import { AccountManager } from '../plugin/accounts.js'
import { kiroDb } from '../plugin/storage/sqlite.js'
import type { KiroAuthDetails, ManagedAccount } from '../plugin/types.js'

// TokenRefresher drives the REAL refreshAccessToken (src/plugin/token.ts) by
// overriding globalThis.fetch, so the refresh HTTP contract runs for real
// (URL, body, error decoding) while staying offline. The AccountManager is
// real (in-memory); the repository + syncFromKiroCli are fakes whose calls we
// assert. No real network, no real timers.

type Variant = 'info' | 'warning' | 'success' | 'error'
type RefreshRequestBody = Record<string, unknown>
type StoredAccountRow = {
  readonly id: string
  readonly refresh_token?: string
  readonly access_token?: string
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

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function makeAccount(o: Partial<ManagedAccount> & { id: string }): ManagedAccount {
  return {
    email: `${o.id}@example.com`,
    authMethod: 'idc',
    region: 'us-east-1',
    clientId: `cid-${o.id}`,
    clientSecret: `cs-${o.id}`,
    profileArn: `arn-${o.id}`,
    refreshToken: `refresh-${o.id}`,
    accessToken: `access-${o.id}`,
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...o
  }
}

function authFor(acc: ManagedAccount, expires: number): KiroAuthDetails {
  return {
    refresh: encodeRefreshToken({
      refreshToken: acc.refreshToken,
      clientId: acc.clientId,
      clientSecret: acc.clientSecret,
      authMethod: 'idc'
    }),
    access: acc.accessToken,
    expires,
    authMethod: 'idc',
    region: acc.region,
    profileArn: acc.profileArn,
    clientId: acc.clientId,
    clientSecret: acc.clientSecret,
    email: acc.email
  }
}

const config = {
  token_expiry_buffer_ms: 120000,
  auto_sync_kiro_cli: true,
  account_selection_strategy: 'sticky' as const
}

function fakeRepo() {
  return {
    findAll: mock(async () => [] as any[]),
    invalidateCache: mock(() => {}),
    batchSave: mock(async () => {}),
    save: mock(async () => {}),
    delete: mock(async () => {}),
    findById: mock(async () => null),
    findHealthyAccounts: mock(async () => [])
  } as any
}

const noToast = (_m: string, _v: Variant) => {}

function parseRefreshRequest(init?: RequestInit): RefreshRequestBody {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected refresh request body to be a JSON string')
  }
  const parsed = JSON.parse(init.body)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected refresh request body to be an object')
  }
  return parsed
}

function capturedRefreshRequest(body: RefreshRequestBody | null): RefreshRequestBody {
  expect(body).not.toBeNull()
  if (!body) {
    throw new Error('Expected refresh request to be captured')
  }
  return body
}

function refreshResponse(accessToken: string, refreshToken: string): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

async function clearStoredAccounts(): Promise<void> {
  const rows: StoredAccountRow[] = kiroDb.getAccounts()
  for (const row of rows) {
    await kiroDb.deleteAccount(row.id)
  }
}

describe('TokenRefresher.refreshIfNeeded - not expired', () => {
  test('skips refresh entirely when the token is still valid', async () => {
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    const sync = mock(async () => {})
    const repo = fakeRepo()
    const refresher = new TokenRefresher(config, mgr, sync, repo)

    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response('{}', { status: 200 })
    }) as any

    const notExpired = authFor(acc, Date.now() + 3600000)
    const result = await refresher.refreshIfNeeded(acc, notExpired, noToast)

    expect(result.shouldContinue).toBe(false)
    expect(result.account).toBe(acc)
    expect(fetchCalled).toBe(false)
    expect(sync).toHaveBeenCalledTimes(0)
    expect(repo.batchSave).toHaveBeenCalledTimes(0)
  })
})

describe('TokenRefresher.refreshIfNeeded - expired, refresh succeeds', () => {
  test('refreshes the token, updates the account, and persists', async () => {
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    const refresher = new TokenRefresher(
      config,
      mgr,
      mock(async () => {}),
      repo
    )

    let requestBody: RefreshRequestBody | null = null
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = parseRefreshRequest(init)
      return refreshResponse('fresh-access-token', 'fresh-refresh-token')
    }) as any

    const expired = authFor(acc, Date.now() - 1000)
    const result = await refresher.refreshIfNeeded(acc, expired, noToast)

    expect(result.shouldContinue).toBe(false)
    // updateFromAuth wrote the new access token onto the managed account.
    expect(mgr.getAccounts().find((a) => a.id === 'A')!.accessToken).toBe('fresh-access-token')
    expect(repo.invalidateCache).toHaveBeenCalledTimes(1)
    expect(repo.findAll).toHaveBeenCalledTimes(1)
    const body = capturedRefreshRequest(requestBody)
    expect(body.refreshToken).toBe('refresh-A')
    expect(repo.batchSave).toHaveBeenCalledTimes(1)
  })
})

describe('TokenRefresher.refreshIfNeeded - expired, DB stale but latest refresh token differs', () => {
  test('rotates with the latest DB refresh material instead of the passed-in auth', async () => {
    const acc = makeAccount({
      id: 'A2-latest',
      refreshToken: 'passed-refresh-token',
      clientId: 'passed-client-id',
      clientSecret: 'passed-client-secret'
    })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    const persisted = makeAccount({
      id: 'A2-latest',
      refreshToken: 'db-refresh-token',
      accessToken: 'db-stale-access-token',
      expiresAt: Date.now() - 1000,
      clientId: 'db-client-id',
      clientSecret: 'db-client-secret'
    })
    const events: string[] = []
    repo.invalidateCache = mock(() => {
      events.push('invalidate')
    })
    repo.findAll = mock(async () => {
      events.push('findAll')
      return [persisted]
    })
    const refresher = new TokenRefresher(
      config,
      mgr,
      mock(async () => {}),
      repo
    )

    let requestBody: RefreshRequestBody | null = null
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      events.push('fetch')
      requestBody = parseRefreshRequest(init)
      return refreshResponse('rotated-access-token', 'rotated-refresh-token')
    }) as any

    const result = await refresher.refreshIfNeeded(acc, authFor(acc, Date.now() - 1000), noToast)

    expect(result.shouldContinue).toBe(false)
    expect(events).toEqual(['invalidate', 'findAll', 'fetch'])
    const body = capturedRefreshRequest(requestBody)
    expect(body.refreshToken).toBe('db-refresh-token')
    expect(body.clientId).toBe('db-client-id')
    expect(body.clientSecret).toBe('db-client-secret')
    expect(body.refreshToken).not.toBe('passed-refresh-token')
    const managed = mgr.getAccounts().find((a) => a.id === 'A2-latest')
    expect(managed?.refreshToken).toBe('rotated-refresh-token')
    expect(managed?.accessToken).toBe('rotated-access-token')
    expect(repo.batchSave).toHaveBeenCalledTimes(1)
  })
})

describe('TokenRefresher.refreshIfNeeded - expired, no DB row fallback', () => {
  test('falls back to the passed-in auth and rotates normally when findAll returns empty', async () => {
    const acc = makeAccount({ id: 'A2-empty', refreshToken: 'fallback-refresh-token' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    repo.findAll = mock(async () => [])
    const refresher = new TokenRefresher(
      config,
      mgr,
      mock(async () => {}),
      repo
    )

    let requestBody: RefreshRequestBody | null = null
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = parseRefreshRequest(init)
      return refreshResponse('fallback-access-token', 'fallback-rotated-refresh-token')
    }) as any

    const result = await refresher.refreshIfNeeded(acc, authFor(acc, Date.now() - 1000), noToast)

    expect(result.shouldContinue).toBe(false)
    expect(repo.invalidateCache).toHaveBeenCalledTimes(1)
    expect(repo.findAll).toHaveBeenCalledTimes(1)
    const body = capturedRefreshRequest(requestBody)
    expect(body.refreshToken).toBe('fallback-refresh-token')
    expect(mgr.getAccounts().find((a) => a.id === 'A2-empty')?.accessToken).toBe(
      'fallback-access-token'
    )
    expect(repo.batchSave).toHaveBeenCalledTimes(1)
  })
})

describe('TokenRefresher.refreshIfNeeded - expired, DB already fresh', () => {
  test('adopts the persisted fresh token and skips refresh and sync', async () => {
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')

    const recovered = makeAccount({
      id: 'A',
      accessToken: 'recovered',
      refreshToken: 'recovered-refresh-token',
      expiresAt: Date.now() + 3600000
    })
    const repo = fakeRepo()
    repo.findAll = mock(async () => [recovered])
    const sync = mock(async () => {})
    const refresher = new TokenRefresher(config, mgr, sync, repo)

    let fetchCalled = false
    const fetchMock = async () => {
      fetchCalled = true
      return new Response(JSON.stringify({ message: 'should not be called' }), { status: 500 })
    }
    fetchMock.preconnect = realFetch.preconnect
    globalThis.fetch = fetchMock

    const result = await refresher.refreshIfNeeded(acc, authFor(acc, Date.now() - 1000), noToast)

    expect(result.shouldContinue).toBe(false)
    expect(result.account).toBe(acc)
    expect(fetchCalled).toBe(false)
    expect(sync).toHaveBeenCalledTimes(0)
    expect(repo.invalidateCache).toHaveBeenCalledTimes(1)
    expect(mgr.getAccounts().find((a) => a.id === 'A')?.accessToken).toBe('recovered')
    expect(mgr.getAccounts().find((a) => a.id === 'A')?.refreshToken).toBe(
      'recovered-refresh-token'
    )
    expect(repo.batchSave).toHaveBeenCalledTimes(0)
  })
})

describe('TokenRefresher.refreshIfNeeded - in-process single-flight', () => {
  test('coalesces concurrent refreshes for the same account into one fetch', async () => {
    const acc = makeAccount({ id: 'A3-single-flight' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    const refresher = new TokenRefresher(
      config,
      mgr,
      mock(async () => {}),
      repo
    )
    let fetchCalls = 0

    globalThis.fetch = (async () => {
      fetchCalls++
      return refreshResponse('single-flight-access-token', 'single-flight-refresh-token')
    }) as any

    const expired = authFor(acc, Date.now() - 1000)
    const [first, second] = await Promise.all([
      refresher.refreshIfNeeded(acc, expired, noToast),
      refresher.refreshIfNeeded(acc, expired, noToast)
    ])

    expect(fetchCalls).toBe(1)
    expect(first.shouldContinue).toBe(false)
    expect(second.shouldContinue).toBe(false)
    expect(mgr.getAccounts().find((a) => a.id === 'A3-single-flight')?.accessToken).toBe(
      'single-flight-access-token'
    )
    expect(repo.batchSave).toHaveBeenCalledTimes(1)
  })

  test('clears the single-flight entry after a failure so a later refresh can run', async () => {
    const acc = makeAccount({ id: 'A3-cleanup' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    repo.findAll = mock(async () => [
      makeAccount({ id: 'A3-cleanup', expiresAt: Date.now() - 1000 })
    ])
    const refresher = new TokenRefresher(
      config,
      mgr,
      mock(async () => {}),
      repo
    )
    let fetchCalls = 0

    globalThis.fetch = (async () => {
      fetchCalls++
      if (fetchCalls === 1) {
        return new Response(JSON.stringify({ message: 'server error' }), { status: 500 })
      }
      return refreshResponse('cleanup-access-token', 'cleanup-refresh-token')
    }) as any

    await expect(
      refresher.refreshIfNeeded(acc, authFor(acc, Date.now() - 1000), noToast)
    ).rejects.toThrow()

    const result = await refresher.refreshIfNeeded(acc, authFor(acc, Date.now() - 1000), noToast)

    expect(result.shouldContinue).toBe(false)
    expect(fetchCalls).toBe(2)
    expect(mgr.getAccounts().find((a) => a.id === 'A3-cleanup')?.accessToken).toBe(
      'cleanup-access-token'
    )
  })
})

describe('TokenRefresher.refreshIfNeeded - cross-process refresh lock composition', () => {
  test('serializes contenders so the second reads the fresh DB token and skips double rotation', async () => {
    // bunfig.toml preloads setup.ts, so this singleton DB is isolated under temp XDG_CONFIG_HOME.
    await clearStoredAccounts()
    const accountId = 'A0-cross-process'
    const stale = makeAccount({
      id: accountId,
      refreshToken: 'R0-cross-process',
      accessToken: 'A0-cross-process',
      expiresAt: Date.now() - 1000,
      clientId: 'cid-cross-process',
      clientSecret: 'cs-cross-process'
    })
    await kiroDb.batchUpsertAccounts([stale])

    const processOneAccount = makeAccount({ ...stale })
    const processTwoAccount = makeAccount({ ...stale })
    const processOneManager = new AccountManager([processOneAccount], 'sticky')
    const processTwoManager = new AccountManager([processTwoAccount], 'sticky')
    const processOneRepo = new AccountRepository(new AccountCache(60000))
    const processTwoRepo = new AccountRepository(new AccountCache(60000))
    const processOneRefresher = new TokenRefresher(
      config,
      processOneManager,
      mock(async () => {}),
      processOneRepo
    )
    const processTwoRefresher = new TokenRefresher(
      config,
      processTwoManager,
      mock(async () => {}),
      processTwoRepo
    )
    const fetchStarted = deferred()
    const releaseFetch = deferred()
    let fetchCalls = 0

    globalThis.fetch = (async () => {
      fetchCalls++
      fetchStarted.resolve()
      await releaseFetch.promise
      return refreshResponse('A1-cross-process', 'R1-cross-process')
    }) as any

    try {
      const first = processOneRefresher.refreshIfNeeded(
        processOneAccount,
        authFor(processOneAccount, Date.now() - 1000),
        noToast
      )
      await fetchStarted.promise
      const second = processTwoRefresher.refreshIfNeeded(
        processTwoAccount,
        authFor(processTwoAccount, Date.now() - 1000),
        noToast
      )
      await Promise.resolve()
      expect(fetchCalls).toBe(1)

      releaseFetch.resolve()
      const [firstResult, secondResult] = await Promise.all([first, second])

      expect(firstResult.shouldContinue).toBe(false)
      expect(secondResult.shouldContinue).toBe(false)
      expect(fetchCalls).toBe(1)
      expect(processOneManager.getAccounts().find((a) => a.id === accountId)?.refreshToken).toBe(
        'R1-cross-process'
      )
      expect(processTwoManager.getAccounts().find((a) => a.id === accountId)?.refreshToken).toBe(
        'R1-cross-process'
      )
      const rows: StoredAccountRow[] = kiroDb.getAccounts()
      const persisted = rows.find((row) => row.id === accountId)
      expect(persisted?.refresh_token).toBe('R1-cross-process')
      expect(persisted?.access_token).toBe('A1-cross-process')
    } finally {
      releaseFetch.resolve()
      await clearStoredAccounts()
    }
  })
})

describe('TokenRefresher.refreshIfNeeded - refresh fails permanently, marks unhealthy', () => {
  test('an invalid-refresh-token 403 with no CLI recovery marks the account permanently unhealthy', async () => {
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    // Sync does not recover it: findAll still returns the stale (expired) row.
    repo.findAll = mock(async () => [makeAccount({ id: 'A', expiresAt: Date.now() - 1000 })])
    const refresher = new TokenRefresher(
      config,
      mgr,
      mock(async () => {}),
      repo
    )

    // 403 whose body message is a permanent marker. refreshAccessToken wraps it
    // as "Refresh failed: Invalid refresh token provided" (code HTTP_403), which
    // handleRefreshError treats as permanent -> markUnhealthy(account, message)
    // -> isPermanentError(message) true -> failCount 10, isHealthy false.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'Invalid refresh token provided' }), {
        status: 403
      })) as any

    const result = await refresher.refreshIfNeeded(acc, authFor(acc, Date.now() - 1000), noToast)

    expect(result.shouldContinue).toBe(true)
    const managed = mgr.getAccounts().find((a) => a.id === 'A')!
    expect(managed.isHealthy).toBe(false)
    expect(managed.failCount).toBe(10) // permanent error path
    expect(managed.unhealthyReason).toContain('Invalid refresh token provided')
    expect(repo.batchSave).toHaveBeenCalledTimes(1)
  })

  test('a non-recoverable, non-permanent error is rethrown', async () => {
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    repo.findAll = mock(async () => [makeAccount({ id: 'A', expiresAt: Date.now() - 1000 })])
    const refresher = new TokenRefresher(
      config,
      mgr,
      mock(async () => {}),
      repo
    )

    // 500 -> code HTTP_500, which is NOT in the permanent list and NOT recovered.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'server error' }), { status: 500 })) as any

    await expect(
      refresher.refreshIfNeeded(acc, authFor(acc, Date.now() - 1000), noToast)
    ).rejects.toThrow()
    // Not marked unhealthy on this path.
    expect(mgr.getAccounts().find((a) => a.id === 'A')!.isHealthy).toBe(true)
  })
})

describe('TokenRefresher.refreshIfNeeded - dead-token reauth toast', () => {
  test('an invalid_grant refresh failure shows one warning toast naming the account and login command', async () => {
    const acc = makeAccount({ id: 'dead-toast', email: 'dead-toast@example.com' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    const refresher = new TokenRefresher(
      config,
      mgr,
      mock(async () => {}),
      repo
    )
    const toastCalls: Array<[string, Variant]> = []

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid grant provided' }),
        { status: 400 }
      )) as any

    const result = await refresher.refreshIfNeeded(
      acc,
      authFor(acc, Date.now() - 1000),
      (message, variant) => toastCalls.push([message, variant])
    )

    expect(result.shouldContinue).toBe(true)
    const managed = mgr.getAccounts().find((a) => a.id === acc.id)
    expect(managed).toBeDefined()
    if (!managed) {
      throw new Error('Expected dead-toast account to remain managed')
    }
    expect(managed.isHealthy).toBe(false)
    expect(repo.batchSave).toHaveBeenCalledTimes(1)
    expect(toastCalls).toHaveLength(1)
    const toast = toastCalls[0]
    expect(toast).toBeDefined()
    if (!toast) {
      throw new Error('Expected one reauth toast')
    }
    expect(toast[0]).toContain('dead-toast@example.com')
    expect(toast[0]).toContain('opencode auth login')
    expect(toast[1]).toBe('warning')
  })

  test('two dead refresh failures for the same account within the debounce window show one toast', async () => {
    const acc = makeAccount({ id: 'dead-toast-debounce', email: 'dead-debounce@example.com' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    const refresher = new TokenRefresher(
      config,
      mgr,
      mock(async () => {}),
      repo
    )
    const toastCalls: Array<[string, Variant]> = []

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid grant provided' }),
        { status: 400 }
      )) as any

    await refresher.refreshIfNeeded(acc, authFor(acc, Date.now() - 1000), (message, variant) =>
      toastCalls.push([message, variant])
    )
    await refresher.refreshIfNeeded(acc, authFor(acc, Date.now() - 1000), (message, variant) =>
      toastCalls.push([message, variant])
    )

    expect(toastCalls).toHaveLength(1)
    expect(toastCalls[0]?.[0]).toContain('dead-debounce@example.com')
  })

  test('dead refresh failures for different accounts each get their own reauth toast', async () => {
    const first = makeAccount({ id: 'dead-toast-A', email: 'dead-a@example.com' })
    const second = makeAccount({ id: 'dead-toast-B', email: 'dead-b@example.com' })
    const mgr = new AccountManager([first, second], 'round-robin')
    const repo = fakeRepo()
    const refresher = new TokenRefresher(
      config,
      mgr,
      mock(async () => {}),
      repo
    )
    const toastCalls: Array<[string, Variant]> = []

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid grant provided' }),
        { status: 400 }
      )) as any

    await refresher.refreshIfNeeded(first, authFor(first, Date.now() - 1000), (message, variant) =>
      toastCalls.push([message, variant])
    )
    await refresher.refreshIfNeeded(
      second,
      authFor(second, Date.now() - 1000),
      (message, variant) => toastCalls.push([message, variant])
    )

    expect(toastCalls).toHaveLength(2)
    expect(toastCalls.map(([message]) => message)).toContain(
      'Kiro account dead-a@example.com sign-in expired — run "opencode auth login" and select kiro-auth to re-authenticate.'
    )
    expect(toastCalls.map(([message]) => message)).toContain(
      'Kiro account dead-b@example.com sign-in expired — run "opencode auth login" and select kiro-auth to re-authenticate.'
    )
    expect(toastCalls.map(([, variant]) => variant)).toEqual(['warning', 'warning'])
  })

  test('a transient refresh failure is rethrown without a reauth toast', async () => {
    const acc = makeAccount({ id: 'transient-toast', email: 'transient-toast@example.com' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    const refresher = new TokenRefresher(
      config,
      mgr,
      mock(async () => {}),
      repo
    )
    const toastCalls: Array<[string, Variant]> = []

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'server error' }), { status: 500 })) as any

    await expect(
      refresher.refreshIfNeeded(acc, authFor(acc, Date.now() - 1000), (message, variant) =>
        toastCalls.push([message, variant])
      )
    ).rejects.toThrow()

    expect(toastCalls).toHaveLength(0)
    const managed = mgr.getAccounts().find((a) => a.id === acc.id)
    expect(managed).toBeDefined()
    if (!managed) {
      throw new Error('Expected transient-toast account to remain managed')
    }
    expect(managed.isHealthy).toBe(true)
  })
})

describe('TokenRefresher.forceRefresh', () => {
  test('returns true and updates the account on success', async () => {
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    const refresher = new TokenRefresher(
      config,
      mgr,
      mock(async () => {}),
      repo
    )

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: 'forced-access', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })) as any

    const result = await refresher.forceRefresh(acc, noToast)
    expect(result).toEqual({ ok: true, dead: false })
    expect(mgr.getAccounts().find((a) => a.id === 'A')!.accessToken).toBe('forced-access')
    expect(repo.batchSave).toHaveBeenCalledTimes(1)
  })

  test('returns false and warns when the refresh fails', async () => {
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    const refresher = new TokenRefresher(
      config,
      mgr,
      mock(async () => {}),
      fakeRepo()
    )

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'denied' }), { status: 403 })) as any

    const toastMsgs: Array<[string, Variant]> = []
    const result = await refresher.forceRefresh(acc, (m, v) => toastMsgs.push([m, v]))
    expect(result.ok).toBe(false)
    expect(result.dead).toBe(true)
    expect(toastMsgs.some(([m, v]) => v === 'warning' && m.includes('403'))).toBe(true)
  })
})
