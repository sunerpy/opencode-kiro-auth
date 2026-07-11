import { afterEach, describe, expect, mock, test } from 'bun:test'
import { AuthHandler } from '../core/auth/auth-handler.js'
import { isRefreshErrorDead, TokenRefresher } from '../core/auth/token-refresher.js'
import { ErrorHandler } from '../core/request/error-handler.js'
import { RequestHandler } from '../core/request/request-handler.js'
import { encodeRefreshToken } from '../kiro/auth.js'
import { AccountManager } from '../plugin/accounts.js'
import { KiroTokenRefreshError } from '../plugin/errors.js'
import {
  isAccessTokenError,
  isPermanentError,
  isRefreshTokenDead,
  toDeadReason
} from '../plugin/health.js'
import type { KiroAuthDetails, ManagedAccount, SdkPreparedRequest } from '../plugin/types.js'

type Variant = 'info' | 'warning' | 'success' | 'error'
const noToast = (_m: string, _v: Variant) => {}

const realFetch = globalThis.fetch
const realSetTimeout = globalThis.setTimeout
afterEach(() => {
  globalThis.fetch = realFetch
  globalThis.setTimeout = realSetTimeout
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

function fakeRepo() {
  return {
    findAll: mock(async () => [] as any[]),
    invalidateCache: mock(() => {}),
    batchSave: mock(async () => {}),
    save: mock(async () => {})
  } as any
}

const refresherConfig = {
  token_expiry_buffer_ms: 120000,
  auto_sync_kiro_cli: false,
  account_selection_strategy: 'sticky' as const
}

// ---------------------------------------------------------------------------
// (a) classifier: isAccessTokenError vs isRefreshTokenDead for every reason
// ---------------------------------------------------------------------------
describe('(a) classifier isAccessTokenError vs isRefreshTokenDead', () => {
  const accessReasons = [
    'The bearer token included in the request is invalid.',
    'the BEARER token included in the request is INVALID',
    'bearer token included in the request is invalid',
    'The access token has expired'
  ]
  const deadReasons = [
    'Invalid refresh token provided',
    'Invalid grant provided',
    'invalid_grant',
    'ExpiredTokenException',
    'InvalidTokenException',
    'ExpiredClientException',
    'Client is expired',
    'HTTP_401',
    'HTTP_403'
  ]

  test('access-token errors: isAccessTokenError=true, isRefreshTokenDead=false', () => {
    for (const r of accessReasons) {
      expect(isAccessTokenError(r)).toBe(true)
      expect(isRefreshTokenDead(r)).toBe(false)
      expect(isPermanentError(r)).toBe(false)
    }
  })

  test('refresh-token-dead errors: isRefreshTokenDead=true, isAccessTokenError=false', () => {
    for (const r of deadReasons) {
      expect(isRefreshTokenDead(r)).toBe(true)
      expect(isPermanentError(r)).toBe(true)
      expect(isAccessTokenError(r)).toBe(false)
    }
  })

  test('empty / undefined reasons classify as neither', () => {
    expect(isAccessTokenError(undefined)).toBe(false)
    expect(isRefreshTokenDead(undefined)).toBe(false)
    expect(isAccessTokenError('')).toBe(false)
    expect(isRefreshTokenDead('')).toBe(false)
  })

  test('toDeadReason turns an access-error reason into a persisted dead reason', () => {
    const dead = toDeadReason('The bearer token included in the request is invalid')
    expect(isRefreshTokenDead(dead)).toBe(true)
    // A reason that is already dead is returned unchanged.
    expect(toDeadReason('Invalid refresh token provided')).toBe('Invalid refresh token provided')
  })

  test('isRefreshErrorDead maps refresh error codes correctly', () => {
    expect(isRefreshErrorDead(new KiroTokenRefreshError('x', 'HTTP_403'))).toBe(true)
    expect(isRefreshErrorDead(new KiroTokenRefreshError('x', 'MISSING_CREDENTIALS'))).toBe(true)
    expect(isRefreshErrorDead(new KiroTokenRefreshError('x', 'INVALID_RESPONSE'))).toBe(true)
    expect(isRefreshErrorDead(new KiroTokenRefreshError('x', 'NETWORK_ERROR'))).toBe(false)
    expect(
      isRefreshErrorDead(new KiroTokenRefreshError('Invalid refresh token provided', 'HTTP_400'))
    ).toBe(true)
    expect(isRefreshErrorDead(new KiroTokenRefreshError('boom', 'HTTP_500'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (b) expired-access + valid-refresh -> refreshIfNeeded refreshes, stays healthy
// ---------------------------------------------------------------------------
describe('(b) expired access + valid refresh -> auto-refresh, stays healthy', () => {
  test('refreshIfNeeded refreshes and the account remains healthy', async () => {
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    const refresher = new TokenRefresher(
      refresherConfig,
      mgr,
      mock(async () => {}),
      repo
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as any

    const result = await refresher.refreshIfNeeded(acc, authFor(acc, Date.now() - 1000), noToast)

    expect(result.shouldContinue).toBe(false)
    const managed = mgr.getAccounts().find((a) => a.id === 'A')!
    expect(managed.accessToken).toBe('fresh')
    expect(managed.isHealthy).toBe(true)
    expect(managed.failCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// token-refresher: transient failure keeps healthy; dead marks unhealthy
// ---------------------------------------------------------------------------
describe('token-refresher handleRefreshError classification', () => {
  test('transient (500, no CLI recovery) is rethrown and NOT marked unhealthy', async () => {
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    repo.findAll = mock(async () => [makeAccount({ id: 'A', expiresAt: Date.now() - 1000 })])
    const refresher = new TokenRefresher(
      { ...refresherConfig, auto_sync_kiro_cli: true },
      mgr,
      mock(async () => {}),
      repo
    )
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'server error' }), { status: 500 })) as any

    await expect(
      refresher.refreshIfNeeded(acc, authFor(acc, Date.now() - 1000), noToast)
    ).rejects.toThrow()
    expect(mgr.getAccounts().find((a) => a.id === 'A')!.isHealthy).toBe(true)
  })

  test('refresh-token-dead (403 invalid refresh token) marks unhealthy permanently', async () => {
    const acc = makeAccount({ id: 'A' })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()
    repo.findAll = mock(async () => [makeAccount({ id: 'A', expiresAt: Date.now() - 1000 })])
    const refresher = new TokenRefresher(
      { ...refresherConfig, auto_sync_kiro_cli: true },
      mgr,
      mock(async () => {}),
      repo
    )
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'Invalid refresh token provided' }), {
        status: 403
      })) as any

    const result = await refresher.refreshIfNeeded(acc, authFor(acc, Date.now() - 1000), noToast)
    expect(result.shouldContinue).toBe(true)
    const managed = mgr.getAccounts().find((a) => a.id === 'A')!
    expect(managed.isHealthy).toBe(false)
    expect(isRefreshTokenDead(managed.unhealthyReason)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (f) restart CALL ORDER: refreshAccessToken BEFORE the SDK send
// ---------------------------------------------------------------------------
const handlerConfig = {
  max_request_iterations: 20,
  request_timeout_ms: 60000,
  rate_limit_max_retries: 3,
  rate_limit_retry_delay_ms: 10,
  enable_log_effort_debug: false,
  enable_log_api_request: false,
  effort: undefined,
  auto_effort_mapping: false,
  token_expiry_buffer_ms: 120000,
  auto_sync_kiro_cli: false,
  account_selection_strategy: 'sticky'
} as any

const KIRO_URL = 'https://q.us-east-1.amazonaws.com/generateAssistantResponse'

function cannedPrep(): SdkPreparedRequest {
  return {
    conversationState: { chatTriggerType: 'MANUAL', conversationId: 'c1' } as any,
    profileArn: 'arn:aws:test',
    streaming: false,
    effectiveModel: 'claude-sonnet-4-5',
    conversationId: 'c1',
    region: 'us-east-1',
    effort: undefined
  }
}

describe('(f) restart proactive refresh: refresh BEFORE SDK send', () => {
  test('a freshly-loaded account with an expired access token refreshes before the first send', async () => {
    const acc = makeAccount({ id: 'A', expiresAt: Date.now() - 1000 })
    const mgr = new AccountManager([acc], 'sticky')
    const repo = fakeRepo()

    const order: string[] = []
    globalThis.fetch = (async () => {
      order.push('refresh')
      return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }) as any

    const handler = new RequestHandler(mgr, handlerConfig, repo)
    const h = handler as any
    const sdkSend = mock(async () => {
      order.push('send')
      return { generateAssistantResponseResponse: {} }
    })
    h.makeSdkClient = () => ({ send: sdkSend })
    h.prepareSdkRequest = () => cannedPrep()
    h.responseHandler = { handleSdkSuccess: mock(async () => new Response('ok')) }
    h.usageTracker = { syncUsage: mock(() => {}) }

    await handler.handle(KIRO_URL, { body: JSON.stringify({ model: 'x' }) }, noToast)

    expect(order[0]).toBe('refresh')
    expect(order).toContain('send')
    expect(order.indexOf('refresh')).toBeLessThan(order.indexOf('send'))
    expect(sdkSend).toHaveBeenCalledTimes(1)
    expect(mgr.getAccounts().find((a) => a.id === 'A')!.accessToken).toBe('fresh')
  })
})

// ---------------------------------------------------------------------------
// (h) AIRTIGHT LOOP: two accounts, both invalid-bearer, refresh "succeeds" but
//     retry still invalid-bearer -> force-refresh <=1/account, sends bounded,
//     loop TERMINATES.
// ---------------------------------------------------------------------------
describe('(h) two-account invalid-bearer loop is bounded and terminates', () => {
  test('each account force-refreshes at most once; total sends bounded; loop throws', async () => {
    globalThis.setTimeout = ((fn: any) => {
      fn()
      return 0 as any
    }) as any

    const a = makeAccount({ id: 'A' })
    const b = makeAccount({ id: 'B' })
    const mgr = new AccountManager([a, b], 'sticky')
    const repo = fakeRepo()

    const handler = new RequestHandler(mgr, handlerConfig, repo)
    const h = handler as any

    // forceRefresh always "succeeds" (token replaced) but the wire keeps
    // returning invalid-bearer, exercising the per-account bound.
    const forceRefresh = mock(async () => ({ ok: true, dead: false }))
    h.tokenRefresher = {
      refreshIfNeeded: mock(async (acc: ManagedAccount) => ({
        shouldContinue: false,
        account: acc
      })),
      forceRefresh
    }
    // Rebuild the error handler so its injected forceRefresh points at the fake.
    h.errorHandler = new ErrorHandler(handlerConfig, mgr, repo, (acc: ManagedAccount, t: any) =>
      h.tokenRefresher.forceRefresh(acc, t)
    )

    const bearerErr: any = new Error('The bearer token included in the request is invalid')
    bearerErr.$metadata = { httpStatusCode: 403 }
    bearerErr.name = 'AccessDeniedException'
    const sdkSend = mock(async () => {
      throw bearerErr
    })
    h.makeSdkClient = () => ({ send: sdkSend })
    h.prepareSdkRequest = () => cannedPrep()
    h.responseHandler = { handleSdkSuccess: mock(async () => new Response('ok')) }
    h.usageTracker = { syncUsage: mock(() => {}) }

    await expect(
      handler.handle(KIRO_URL, { body: JSON.stringify({ model: 'x' }) }, noToast)
    ).rejects.toThrow()

    // Bound proof: exactly one force-refresh per account.
    expect(forceRefresh).toHaveBeenCalledTimes(2)
    const refreshedIds = forceRefresh.mock.calls.map((c: any[]) => c[0].id).sort()
    expect(refreshedIds).toEqual(['A', 'B'])
    // Sends are finite and small (2 per account: pre-refresh + post-refresh retry).
    expect(sdkSend.mock.calls.length).toBeLessThanOrEqual(handlerConfig.max_request_iterations)
    expect(sdkSend.mock.calls.length).toBe(4)
    // Both accounts ended needs-reauth (refresh-dead), so nothing loops forever.
    for (const acc of mgr.getAccounts()) {
      expect(acc.isHealthy).toBe(false)
      expect(isRefreshTokenDead(acc.unhealthyReason)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// (i) getCurrentOrNext transitions
// ---------------------------------------------------------------------------
describe('(i) getCurrentOrNext state transitions', () => {
  test('refresh-token-dead account is excluded and never auto-healed', () => {
    const dead = makeAccount({
      id: 'A',
      isHealthy: false,
      unhealthyReason: 'InvalidTokenException: bearer token included in the request is invalid',
      failCount: 10,
      recoveryTime: Date.now() - 1000
    })
    const mgr = new AccountManager([dead], 'sticky')
    expect(mgr.getCurrentOrNext()).toBeNull()
    expect(mgr.getAccounts().find((a) => a.id === 'A')!.isHealthy).toBe(false)
  })

  test('legacy access-error row with failCount=10 heals-by-refresh (reset + selectable)', () => {
    const legacy = makeAccount({
      id: 'A',
      isHealthy: false,
      unhealthyReason: 'The bearer token included in the request is invalid',
      failCount: 10
    })
    const mgr = new AccountManager([legacy], 'sticky')
    const selected = mgr.getCurrentOrNext()
    expect(selected?.id).toBe('A')
    expect(selected?.isHealthy).toBe(true)
    expect(selected?.failCount).toBe(0)
    expect(selected?.unhealthyReason).toBeUndefined()
  })

  test('a genuinely refresh-dead row is NOT resurrected by the heal-by-refresh path', () => {
    const dead = makeAccount({
      id: 'A',
      isHealthy: false,
      unhealthyReason: 'Invalid refresh token provided',
      failCount: 10
    })
    const mgr = new AccountManager([dead], 'sticky')
    expect(mgr.getCurrentOrNext()).toBeNull()
  })

  test('a healthy (access-expired-only) account is selectable without ever being marked unhealthy', () => {
    const acc = makeAccount({ id: 'A', expiresAt: Date.now() - 1000 })
    const mgr = new AccountManager([acc], 'sticky')
    const selected = mgr.getCurrentOrNext()
    expect(selected?.id).toBe('A')
    expect(selected?.isHealthy).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (g) display honesty in the auth menu
// ---------------------------------------------------------------------------
describe('(g) auth-menu health display honesty', () => {
  function makeAuthHandler(accounts: any[]) {
    const handler = new AuthHandler({}, {} as any)
    handler.setAccountManager({ getAccounts: () => accounts })
    return handler
  }

  test('refresh-token-dead account shows a (needs re-login) marker', () => {
    const handler = makeAuthHandler([
      {
        id: 'x',
        email: 'dead@b.com',
        usedCount: 10,
        limitCount: 100,
        isHealthy: false,
        unhealthyReason: 'Invalid refresh token provided',
        region: 'us-east-1'
      }
    ])
    const label = handler.getMethods()[0]!.label
    expect(label).toContain('dead@b.com')
    expect(label).toContain('(needs re-login)')
  })

  test('access-expired-only account is shown usable (no re-login marker)', () => {
    const handler = makeAuthHandler([
      {
        id: 'x',
        email: 'ok@b.com',
        usedCount: 10,
        limitCount: 100,
        isHealthy: false,
        unhealthyReason: 'The bearer token included in the request is invalid',
        region: 'us-east-1'
      }
    ])
    const label = handler.getMethods()[0]!.label
    expect(label).toContain('ok@b.com')
    expect(label).not.toContain('needs re-login')
  })
})

// ---------------------------------------------------------------------------
// (j) corrupted-cred row: refresh throws (decode fails) -> dead -> excluded
// ---------------------------------------------------------------------------
describe('(j) corrupted-credential row degrades to dead + excluded, no crash/loop', () => {
  test('a missing-client idc refresh classifies dead and is excluded, forceRefresh returns dead', async () => {
    // idc account with no clientId/clientSecret: refreshAccessToken throws
    // MISSING_CREDENTIALS before any network call.
    const corrupt = makeAccount({
      id: 'A',
      clientId: undefined,
      clientSecret: undefined,
      refreshToken: 'short'
    })
    const mgr = new AccountManager([corrupt], 'sticky')
    const repo = fakeRepo()
    const refresher = new TokenRefresher(
      refresherConfig,
      mgr,
      mock(async () => {}),
      repo
    )

    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response('{}', { status: 200 })
    }) as any

    const result = await refresher.forceRefresh(corrupt, noToast)
    expect(result).toEqual({ ok: false, dead: true })
    expect(fetchCalled).toBe(false)

    // Simulate the error-handler persisting the dead classification, then prove
    // selection excludes it (no crash, no loop).
    mgr.markUnhealthy(corrupt, toDeadReason('The bearer token included in the request is invalid'))
    expect(mgr.getCurrentOrNext()).toBeNull()
  })
})
