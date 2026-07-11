import { afterEach, describe, expect, mock, test } from 'bun:test'
import { TokenRefresher } from '../core/auth/token-refresher.js'
import { encodeRefreshToken } from '../kiro/auth.js'
import { AccountManager } from '../plugin/accounts.js'
import type { KiroAuthDetails, ManagedAccount } from '../plugin/types.js'

// TokenRefresher drives the REAL refreshAccessToken (src/plugin/token.ts) by
// overriding globalThis.fetch, so the refresh HTTP contract runs for real
// (URL, body, error decoding) while staying offline. The AccountManager is
// real (in-memory); the repository + syncFromKiroCli are fakes whose calls we
// assert. No real network, no real timers.

type Variant = 'info' | 'warning' | 'success' | 'error'

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

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'fresh-access-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as any

    const expired = authFor(acc, Date.now() - 1000)
    const result = await refresher.refreshIfNeeded(acc, expired, noToast)

    expect(result.shouldContinue).toBe(false)
    // updateFromAuth wrote the new access token onto the managed account.
    expect(mgr.getAccounts().find((a) => a.id === 'A')!.accessToken).toBe('fresh-access-token')
    expect(repo.batchSave).toHaveBeenCalledTimes(1)
  })
})

describe('TokenRefresher.refreshIfNeeded - refresh fails, recovered via CLI sync', () => {
  test('when sync repopulates a fresh token, returns that account and shouldContinue=true', async () => {
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')

    // After the failed refresh, sync "recovers" a fresh-token version of the
    // same id from the CLI; repository.findAll returns it with a future expiry.
    const recovered = makeAccount({
      id: 'A',
      accessToken: 'recovered',
      expiresAt: Date.now() + 3600000
    })
    const repo = fakeRepo()
    repo.findAll = mock(async () => [recovered])
    const sync = mock(async () => {})
    const refresher = new TokenRefresher(config, mgr, sync, repo)

    // Refresh endpoint returns 500 -> refreshAccessToken throws.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'boom' }), { status: 500 })) as any

    const toastMsgs: Array<[string, Variant]> = []
    const result = await refresher.refreshIfNeeded(acc, authFor(acc, Date.now() - 1000), (m, v) =>
      toastMsgs.push([m, v])
    )

    expect(sync).toHaveBeenCalledTimes(1)
    expect(repo.invalidateCache).toHaveBeenCalledTimes(1)
    expect(result.shouldContinue).toBe(true)
    expect(result.account.accessToken).toBe('recovered')
    expect(toastMsgs.some(([m]) => m.includes('recovered'))).toBe(true)
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

    const ok = await refresher.forceRefresh(acc, noToast)
    expect(ok).toBe(true)
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
    const ok = await refresher.forceRefresh(acc, (m, v) => toastMsgs.push([m, v]))
    expect(ok).toBe(false)
    expect(toastMsgs.some(([m, v]) => v === 'warning' && m.includes('403'))).toBe(true)
  })
})
