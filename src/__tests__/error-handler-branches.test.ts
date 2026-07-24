import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { ErrorHandler } from '../core/request/error-handler.js'
import type { ManagedAccount } from '../plugin/types.js'

type ToastFn = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

const CONFIG = { rate_limit_max_retries: 3, rate_limit_retry_delay_ms: 5000 }

// The handler sleeps via setTimeout on 500 / 429 / 403-backoff paths. Replace
// setTimeout with an immediate-fire stub so retries resolve without real delay
// (no flaky timing), and record the delays it was asked to wait.
const realSetTimeout = globalThis.setTimeout
let sleepCalls: number[] = []

beforeEach(() => {
  sleepCalls = []
  // @ts-expect-error test stub signature
  globalThis.setTimeout = (fn: (...a: any[]) => void, ms?: number) => {
    sleepCalls.push(ms ?? 0)
    fn()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }
})

afterEach(() => {
  globalThis.setTimeout = realSetTimeout
})

function makeAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc-1',
    email: 'user@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: 'refresh-token',
    accessToken: 'access-token',
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides
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

const noopToast: ToastFn = () => {}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

describe('ErrorHandler 400', () => {
  test('400 never retries and surfaces the reason', async () => {
    const toast = mock(noopToast)
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const res = await handler.handle(
      new Error('bad'),
      jsonResponse(400, { message: 'Bad input' }),
      makeAccount(),
      { retry: 0 },
      toast
    )
    expect(res.shouldRetry).toBe(false)
    expect(toast).toHaveBeenCalledWith('400: Bad input', 'error')
  })
})

describe('ErrorHandler 401', () => {
  test('401 under the retry cap retries with an incremented context', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const res = await handler.handle(
      new Error('unauth'),
      jsonResponse(401, { message: 'Unauthorized' }),
      makeAccount(),
      { retry: 0 },
      noopToast
    )
    expect(res.shouldRetry).toBe(true)
    expect(res.newContext?.retry).toBe(1)
  })

  test('401 at the retry cap falls through to the default no-retry path', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const res = await handler.handle(
      new Error('unauth'),
      jsonResponse(401, { message: 'Unauthorized' }),
      makeAccount(),
      { retry: 3 },
      noopToast
    )
    expect(res.shouldRetry).toBe(false)
  })
})

describe('ErrorHandler 500 exponential backoff', () => {
  test('below the failCount ceiling: increments failCount, sleeps exp backoff, retries', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const account = makeAccount({ failCount: 0 })

    const res = await handler.handle(
      new Error('500'),
      jsonResponse(500, { message: 'Internal Server Error' }),
      account,
      { retry: 0 },
      noopToast
    )

    expect(account.failCount).toBe(1)
    expect(res.shouldRetry).toBe(true)
    expect(res.switchAccount).toBeUndefined()
    // First failure: delay = 1000 * 2^0 = 1000ms.
    expect(sleepCalls).toContain(1000)
  })

  test('backoff grows with failCount (second failure sleeps 2000ms)', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const account = makeAccount({ failCount: 1 })

    await handler.handle(new Error('500'), jsonResponse(500, {}), account, { retry: 0 }, noopToast)

    expect(account.failCount).toBe(2)
    // Second failure: delay = 1000 * 2^1 = 2000ms.
    expect(sleepCalls).toContain(2000)
  })

  test('at failCount >= 5: marks unhealthy, saves, retries with switchAccount', async () => {
    const manager = makeAccountManager(2)
    const repo = makeRepository()
    const handler = new ErrorHandler(CONFIG, manager, repo)
    const account = makeAccount({ failCount: 4 })

    const res = await handler.handle(
      new Error('500'),
      jsonResponse(500, { Message: 'boom' }),
      account,
      { retry: 0 },
      noopToast
    )

    expect(account.failCount).toBe(5)
    expect(manager.markUnhealthy).toHaveBeenCalledTimes(1)
    expect(repo.batchSave).toHaveBeenCalledTimes(1)
    expect(res.shouldRetry).toBe(true)
    expect(res.switchAccount).toBe(true)
  })
})

describe('ErrorHandler 429 rate limiting', () => {
  test('multi-account: marks rate-limited, saves, switches account without sleeping', async () => {
    const manager = makeAccountManager(3)
    const repo = makeRepository()
    const handler = new ErrorHandler(CONFIG, manager, repo)
    const account = makeAccount()

    const res = await handler.handle(
      new Error('429'),
      jsonResponse(429, {}, { 'retry-after': '30' }),
      account,
      { retry: 0 },
      noopToast
    )

    expect(manager.markRateLimited).toHaveBeenCalledTimes(1)
    // retry-after: 30s -> 30000ms passed to markRateLimited.
    expect(manager.markRateLimited.mock.calls[0][1]).toBe(30000)
    expect(repo.batchSave).toHaveBeenCalledTimes(1)
    expect(res.shouldRetry).toBe(true)
    expect(res.switchAccount).toBe(true)
    expect(sleepCalls).toHaveLength(0)
  })

  test('single-account: waits out the retry-after window then retries in place', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const res = await handler.handle(
      new Error('429'),
      jsonResponse(429, {}, { 'retry-after': '5' }),
      makeAccount(),
      { retry: 0 },
      noopToast
    )
    expect(res.shouldRetry).toBe(true)
    expect(res.switchAccount).toBeUndefined()
    expect(sleepCalls).toContain(5000)
  })

  test('429 with no retry-after header defaults to 60s', async () => {
    const manager = makeAccountManager(1)
    const handler = new ErrorHandler(CONFIG, manager, makeRepository())
    await handler.handle(
      new Error('429'),
      jsonResponse(429, {}),
      makeAccount(),
      { retry: 0 },
      noopToast
    )
    expect(manager.markRateLimited.mock.calls[0][1]).toBe(60000)
    expect(sleepCalls).toContain(60000)
  })

  test('single-account retry-after rejects immediately when already aborted', async () => {
    const controller = new AbortController()
    const reason = new DOMException('cancelled', 'AbortError')
    controller.abort(reason)
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())

    await expect(
      handler.handle(
        new Error('429'),
        jsonResponse(429, {}, { 'retry-after': '60' }),
        makeAccount(),
        { retry: 0 },
        noopToast,
        controller.signal
      )
    ).rejects.toBe(reason)
  })
})

describe('ErrorHandler 402 / 403 quota & permanence', () => {
  test('INVALID_MODEL_ID throws (never retried or swallowed)', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    await expect(
      handler.handle(
        new Error('model'),
        jsonResponse(403, { reason: 'INVALID_MODEL_ID', message: 'no such model' }),
        makeAccount(),
        { retry: 0 },
        noopToast
      )
    ).rejects.toThrow('Invalid model: no such model')
  })

  test('402 single-account permanent quota surfaces without retry (uses message reason)', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const account = makeAccount()
    const res = await handler.handle(
      new Error('402'),
      jsonResponse(402, { message: 'Free tier exhausted' }),
      account,
      { retry: 0 },
      noopToast
    )
    // 402 is not the retryable-403 branch, so single-account => no retry.
    expect(res.shouldRetry).toBe(false)
  })

  test('402 multi-account: marks unhealthy and switches', async () => {
    const manager = makeAccountManager(2)
    const repo = makeRepository()
    const handler = new ErrorHandler(CONFIG, manager, repo)
    const account = makeAccount()

    const res = await handler.handle(
      new Error('402'),
      jsonResponse(402, { message: 'Quota' }),
      account,
      { retry: 0 },
      noopToast
    )

    expect(manager.markUnhealthy).toHaveBeenCalledTimes(1)
    expect(repo.batchSave).toHaveBeenCalledTimes(1)
    expect(res.shouldRetry).toBe(true)
    expect(res.switchAccount).toBe(true)
  })

  test('TEMPORARILY_SUSPENDED is permanent: failCount forced to 10, no retry (single account)', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const account = makeAccount()
    const res = await handler.handle(
      new Error('susp'),
      jsonResponse(403, { reason: 'TEMPORARILY_SUSPENDED', message: 'x' }),
      account,
      { retry: 0 },
      noopToast
    )
    expect(account.failCount).toBe(10)
    expect(res.shouldRetry).toBe(false)
  })

  test('403 non-permanent (generic) single-account under cap: exp backoff retry with incremented retry', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const account = makeAccount()
    const res = await handler.handle(
      new Error('403'),
      jsonResponse(403, { message: 'Transient forbidden' }),
      account,
      { retry: 1 },
      noopToast
    )
    expect(res.shouldRetry).toBe(true)
    expect(res.newContext?.retry).toBe(2)
    // delay = rate_limit_retry_delay_ms * 2^retry = 5000 * 2^1 = 10000ms.
    expect(sleepCalls).toContain(10000)
  })

  test('403 non-permanent single-account at the retry cap surfaces without retry', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const res = await handler.handle(
      new Error('403'),
      jsonResponse(403, { message: 'Transient forbidden' }),
      makeAccount(),
      { retry: 3 },
      noopToast
    )
    expect(res.shouldRetry).toBe(false)
  })

  test('403 with non-JSON body still resolves to a Forbidden no-retry (single account)', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const res = await handler.handle(
      new Error('403'),
      new Response('not json at all', { status: 403 }),
      makeAccount(),
      { retry: 3 },
      noopToast
    )
    expect(res.shouldRetry).toBe(false)
  })
})

describe('ErrorHandler unknown status default path', () => {
  test('an unhandled status (e.g. 418) surfaces without retry', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const res = await handler.handle(
      new Error('teapot'),
      jsonResponse(418, { message: "I'm a teapot" }),
      makeAccount(),
      { retry: 0 },
      noopToast
    )
    expect(res.shouldRetry).toBe(false)
  })
})

describe('ErrorHandler network errors', () => {
  test('a recognized network error under the cap retries with backoff', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const res = await handler.handleNetworkError(
      new Error('ECONNRESET while reading'),
      { retry: 0 },
      noopToast
    )
    expect(res.shouldRetry).toBe(true)
    expect(res.newContext?.retry).toBe(1)
    // delay = 5000 * 2^0 = 5000ms.
    expect(sleepCalls).toContain(5000)
  })

  test('fetch failed is treated as a network error', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const res = await handler.handleNetworkError(new Error('fetch failed'), { retry: 0 }, noopToast)
    expect(res.shouldRetry).toBe(true)
  })

  test('a non-network error does not retry', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const res = await handler.handleNetworkError(
      new Error('some unrelated bug'),
      { retry: 0 },
      noopToast
    )
    expect(res.shouldRetry).toBe(false)
  })

  test('a network error at the retry cap does not retry', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const res = await handler.handleNetworkError(new Error('ETIMEDOUT'), { retry: 3 }, noopToast)
    expect(res.shouldRetry).toBe(false)
  })

  test('a non-Error value is not treated as a network error', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const res = await handler.handleNetworkError('string error' as any, { retry: 0 }, noopToast)
    expect(res.shouldRetry).toBe(false)
  })

  test('an already-aborted signal interrupts network backoff', async () => {
    const controller = new AbortController()
    const reason = new DOMException('cancelled', 'AbortError')
    controller.abort(reason)
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())

    await expect(
      handler.handleNetworkError(
        new Error('ECONNRESET'),
        { retry: 0 },
        noopToast,
        controller.signal
      )
    ).rejects.toBe(reason)
  })
})

describe('ErrorHandler abortable HTTP backoffs', () => {
  test('an already-aborted signal interrupts 500 and transient 403 backoffs', async () => {
    const controller = new AbortController()
    const reason = new DOMException('cancelled', 'AbortError')
    controller.abort(reason)
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())

    await expect(
      handler.handle(
        new Error('500'),
        jsonResponse(500, {}),
        makeAccount(),
        { retry: 0 },
        noopToast,
        controller.signal
      )
    ).rejects.toBe(reason)
    await expect(
      handler.handle(
        new Error('403'),
        jsonResponse(403, { message: 'Transient forbidden' }),
        makeAccount(),
        { retry: 0 },
        noopToast,
        controller.signal
      )
    ).rejects.toBe(reason)
  })
})
