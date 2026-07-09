import { describe, expect, mock, test } from 'bun:test'
import { ErrorHandler } from '../core/request/error-handler.js'
import type { ManagedAccount } from '../plugin/types.js'

type ToastFn = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

const noopToast: ToastFn = () => {}

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

describe('invalid-bearer 403 one-shot refresh + retry', () => {
  test('OLD behavior (no forceRefresh injected) surfaces permanent, no retry', async () => {
    // Failing-first proof: no injected refresh -> pre-fix path, invalid-bearer is permanent.
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const account = makeAccount()

    const result = await handler.handle(
      new Error('bearer'),
      bearerResponse(),
      account,
      { retry: 0 },
      noopToast
    )

    expect(result.shouldRetry).toBe(false)
    expect(account.failCount).toBe(10)
  })

  test('happy path: fires exactly ONE refresh and returns shouldRetry with guard set', async () => {
    const forceRefresh = mock(async () => true)
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
    expect(result.newContext?.bearerRefreshAttempted).toBe(true)
    expect(result.switchAccount).toBeUndefined()
    expect(account.failCount).toBe(0)
  })

  test('one-shot guard: two invalid-bearer 403s refresh only once; second is permanent', async () => {
    const forceRefresh = mock(async () => true)
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository(), forceRefresh)
    const account = makeAccount()

    const first = await handler.handle(
      new Error('bearer'),
      bearerResponse(),
      account,
      { retry: 0 },
      noopToast
    )
    expect(first.shouldRetry).toBe(true)
    expect(first.newContext?.bearerRefreshAttempted).toBe(true)

    const second = await handler.handle(
      new Error('bearer'),
      bearerResponse(),
      account,
      first.newContext!,
      noopToast
    )

    expect(forceRefresh).toHaveBeenCalledTimes(1)
    expect(second.shouldRetry).toBe(false)
    expect(account.failCount).toBe(10)
  })

  test('refresh failure: forceRefresh returns false -> permanent, no retry', async () => {
    const forceRefresh = mock(async () => false)
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
    expect(result.shouldRetry).toBe(false)
    expect(account.failCount).toBe(10)
  })

  test('regression: TEMPORARILY_SUSPENDED -> NO refresh, NO retry, permanent immediately', async () => {
    const forceRefresh = mock(async () => true)
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
