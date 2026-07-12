import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ForceRefreshResult } from '../core/auth/token-refresher.js'
import { ErrorHandler } from '../core/request/error-handler.js'
import type { ManagedAccount } from '../plugin/types.js'

type ToastFn = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

const noopToast: ToastFn = () => {}

const realSetTimeout = globalThis.setTimeout
beforeEach(() => {
  // @ts-expect-error test stub signature
  globalThis.setTimeout = (fn: (...a: any[]) => void) => {
    fn()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }
})
afterEach(() => {
  globalThis.setTimeout = realSetTimeout
})

const CONFIG = { rate_limit_max_retries: 3, rate_limit_retry_delay_ms: 5000 }

function makeAccount(): ManagedAccount {
  return {
    id: 'acc-1',
    email: 'user@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: 'refresh-token',
    accessToken: 'stale-access-token',
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0
  }
}

function makeAccountManager(count: number) {
  return {
    getAccountCount: () => count,
    getAccounts: () => [],
    markUnhealthy: mock(() => {}),
    markRateLimited: mock(() => {})
  } as any
}

function makeRepository() {
  return { batchSave: mock(async () => {}) } as any
}

const ok: ForceRefreshResult = { ok: true, dead: false }
const deadFail: ForceRefreshResult = { ok: false, dead: true }
const transientFail: ForceRefreshResult = { ok: false, dead: false }

function bearerResponse(): Response {
  return new Response(
    JSON.stringify({
      message: 'The bearer token included in the request is invalid.',
      __type: 'AccessDeniedException'
    }),
    { status: 403, headers: { 'Content-Type': 'application/json' } }
  )
}

function suspendedResponse(): Response {
  return new Response(
    JSON.stringify({ reason: 'TEMPORARILY_SUSPENDED', message: 'Account Suspended' }),
    { status: 403, headers: { 'Content-Type': 'application/json' } }
  )
}

describe('invalid-bearer 403 force-refresh + retry (per-account bound)', () => {
  test('no forceRefresh injected: invalid-bearer is NOT permanent (transient backoff, failCount not forced to 10)', async () => {
    const manager = makeAccountManager(1)
    const handler = new ErrorHandler(CONFIG, manager, makeRepository())
    const account = makeAccount()

    const result = await handler.handle(
      new Error('bearer'),
      bearerResponse(),
      account,
      { retry: 0 },
      noopToast
    )

    expect(result.shouldRetry).toBe(true)
    expect(result.newContext?.retry).toBe(1)
    expect(account.failCount).toBe(0)
    expect(manager.markUnhealthy).toHaveBeenCalledTimes(0)
  })

  test('happy path: fires exactly ONE refresh, retries, records the account id, not permanent', async () => {
    const forceRefresh = mock(async () => ok)
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository(), forceRefresh)
    const account = makeAccount()

    const result = await handler.handle(
      new Error('bearer'),
      bearerResponse(),
      account,
      { retry: 0 },
      noopToast
    )

    expect(forceRefresh).toHaveBeenCalledTimes(1)
    expect(result.shouldRetry).toBe(true)
    expect(result.newContext?.forcedRefreshAccountIds?.has('acc-1')).toBe(true)
    expect(result.switchAccount).toBeUndefined()
    expect(account.failCount).toBe(0)
  })

  test('per-account bound: two invalid-bearer 403s for the same account refresh only once; second is needs-reauth', async () => {
    const forceRefresh = mock(async () => ok)
    const manager = makeAccountManager(1)
    const handler = new ErrorHandler(CONFIG, manager, makeRepository(), forceRefresh)
    const account = makeAccount()

    const first = await handler.handle(
      new Error('bearer'),
      bearerResponse(),
      account,
      { retry: 0 },
      noopToast
    )
    expect(first.shouldRetry).toBe(true)
    expect(first.newContext?.forcedRefreshAccountIds?.has('acc-1')).toBe(true)

    const second = await handler.handle(
      new Error('bearer'),
      bearerResponse(),
      account,
      first.newContext!,
      noopToast
    )

    expect(forceRefresh).toHaveBeenCalledTimes(1)
    expect(second.shouldRetry).toBe(false)
    expect(manager.markUnhealthy).toHaveBeenCalledTimes(1)
    const reason = manager.markUnhealthy.mock.calls[0][1] as string
    expect(reason).toContain('InvalidTokenException')
  })

  test('refresh fails dead: single-account -> needs-reauth, no retry', async () => {
    const forceRefresh = mock(async () => deadFail)
    const manager = makeAccountManager(1)
    const handler = new ErrorHandler(CONFIG, manager, makeRepository(), forceRefresh)
    const account = makeAccount()

    const result = await handler.handle(
      new Error('bearer'),
      bearerResponse(),
      account,
      { retry: 0 },
      noopToast
    )

    expect(forceRefresh).toHaveBeenCalledTimes(1)
    expect(result.shouldRetry).toBe(false)
    expect(manager.markUnhealthy).toHaveBeenCalledTimes(1)
  })

  test('refresh fails transient: single-account -> NOT permanent, backoff retry', async () => {
    const forceRefresh = mock(async () => transientFail)
    const manager = makeAccountManager(1)
    const handler = new ErrorHandler(CONFIG, manager, makeRepository(), forceRefresh)
    const account = makeAccount()

    const result = await handler.handle(
      new Error('bearer'),
      bearerResponse(),
      account,
      { retry: 0 },
      noopToast
    )

    expect(forceRefresh).toHaveBeenCalledTimes(1)
    expect(result.shouldRetry).toBe(true)
    expect(result.newContext?.retry).toBe(1)
    expect(manager.markUnhealthy).toHaveBeenCalledTimes(0)
    expect(account.failCount).toBe(0)
  })

  test('regression: TEMPORARILY_SUSPENDED -> NO refresh, NO retry, permanent immediately', async () => {
    const forceRefresh = mock(async () => ok)
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository(), forceRefresh)
    const account = makeAccount()

    const result = await handler.handle(
      new Error('suspended'),
      suspendedResponse(),
      account,
      { retry: 0 },
      noopToast
    )

    expect(forceRefresh).toHaveBeenCalledTimes(0)
    expect(result.shouldRetry).toBe(false)
    expect(account.failCount).toBe(10)
  })
})
