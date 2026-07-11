import { afterEach, describe, expect, mock, test } from 'bun:test'
import { RequestHandler } from '../core/request/request-handler.js'
import type { ManagedAccount, SdkPreparedRequest } from '../plugin/types.js'

// RequestHandler is pure orchestration: handle() routes by KIRO_API_PATTERN
// (non-Kiro -> global fetch passthrough; Kiro -> serial queue -> handleKiroRequest),
// and handleKiroRequest drives select -> refresh -> prepare -> sdk send -> success/error.
// We construct a REAL RequestHandler and swap its private collaborators for fakes
// (plain objects with mock fns) plus override the two internal seams
// (makeSdkClient, prepareSdkRequest) so NO network, NO real SDK, NO real timers.

type Variant = 'info' | 'warning' | 'success' | 'error'

const realFetch = globalThis.fetch
const realSetTimeout = globalThis.setTimeout
afterEach(() => {
  globalThis.fetch = realFetch
  globalThis.setTimeout = realSetTimeout
})

const noToast = (_m: string, _v: Variant) => {}

const KIRO_URL = 'https://q.us-east-1.amazonaws.com/generateAssistantResponse'

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

const baseConfig = {
  max_request_iterations: 20,
  request_timeout_ms: 60000,
  rate_limit_max_retries: 3,
  rate_limit_retry_delay_ms: 100,
  enable_log_effort_debug: false,
  enable_log_api_request: false,
  effort: undefined,
  auto_effort_mapping: false,
  token_expiry_buffer_ms: 120000,
  auto_sync_kiro_cli: true,
  account_selection_strategy: 'sticky'
} as any

interface Fakes {
  accountSelector: { selectHealthyAccount: ReturnType<typeof mock> }
  tokenRefresher: {
    refreshIfNeeded: ReturnType<typeof mock>
    forceRefresh: ReturnType<typeof mock>
  }
  errorHandler: { handle: ReturnType<typeof mock>; handleNetworkError: ReturnType<typeof mock> }
  responseHandler: { handleSdkSuccess: ReturnType<typeof mock> }
  usageTracker: { syncUsage: ReturnType<typeof mock> }
  sdkSend: ReturnType<typeof mock>
  accountManager: any
  repository: any
}

function buildHandler(opts: {
  accounts?: ManagedAccount[]
  selectResults?: Array<ManagedAccount | null | Error>
  sdkResults?: Array<any | Error>
  errorHandleResults?: Array<any>
  responseResult?: Response
}): { handler: RequestHandler; fakes: Fakes } {
  const accounts = opts.accounts ?? []
  const selectQueue = [...(opts.selectResults ?? [])]
  const sdkQueue = [...(opts.sdkResults ?? [])]
  const errorQueue = [...(opts.errorHandleResults ?? [])]

  const accountManager: any = {
    getAccounts: mock(() => accounts),
    toAuthDetails: mock((acc: ManagedAccount) => ({
      access: acc.accessToken,
      refresh: acc.refreshToken,
      expires: acc.expiresAt,
      authMethod: 'idc',
      region: acc.region,
      email: acc.email
    }))
  }
  const repository: any = { save: mock(async () => {}) }

  const accountSelector = {
    selectHealthyAccount: mock(async () => {
      const next = selectQueue.shift()
      if (next instanceof Error) throw next
      return next ?? null
    })
  }
  const tokenRefresher = {
    refreshIfNeeded: mock(async (acc: ManagedAccount) => ({
      shouldContinue: false,
      account: acc
    })),
    forceRefresh: mock(async () => true)
  }
  const errorHandler = {
    handle: mock(async () => errorQueue.shift() ?? { shouldRetry: false }),
    handleNetworkError: mock(async () => ({ shouldRetry: false }))
  }
  const responseHandler = {
    handleSdkSuccess: mock(async () => opts.responseResult ?? new Response('ok'))
  }
  const usageTracker = { syncUsage: mock(() => {}) }

  const sdkSend = mock(async () => {
    const next = sdkQueue.shift()
    if (next instanceof Error) throw next
    return next ?? {}
  })

  const handler = new RequestHandler(accountManager, baseConfig, repository)
  const h = handler as any
  h.accountSelector = accountSelector
  h.tokenRefresher = tokenRefresher
  h.errorHandler = errorHandler
  h.responseHandler = responseHandler
  h.usageTracker = usageTracker
  h.makeSdkClient = () => ({ send: sdkSend })
  h.prepareSdkRequest = () => cannedPrep()

  return {
    handler,
    fakes: {
      accountSelector,
      tokenRefresher,
      errorHandler,
      responseHandler,
      usageTracker,
      sdkSend,
      accountManager,
      repository
    }
  }
}

describe('RequestHandler.handle — routing', () => {
  test('non-Kiro URL passes straight through to global fetch untouched', async () => {
    const sentinel = new Response('passthrough', { status: 201 })
    let fetchArgs: any[] = []
    globalThis.fetch = (async (...args: any[]) => {
      fetchArgs = args
      return sentinel
    }) as any

    const { handler, fakes } = buildHandler({})
    const init = { method: 'GET' }
    const res = await handler.handle('https://api.openai.com/v1/models', init, noToast)

    expect(res).toBe(sentinel)
    expect(fetchArgs[0]).toBe('https://api.openai.com/v1/models')
    expect(fetchArgs[1]).toBe(init)
    // No Kiro collaborators were touched on the passthrough path.
    expect(fakes.accountSelector.selectHealthyAccount).toHaveBeenCalledTimes(0)
    expect(fakes.sdkSend).toHaveBeenCalledTimes(0)
  })

  test('Request-object input routes by its .url property', async () => {
    globalThis.fetch = (async () => new Response('x')) as any
    const { handler, fakes } = buildHandler({})
    await handler.handle({ url: 'https://example.com/foo' }, {}, noToast)
    expect(fakes.accountSelector.selectHealthyAccount).toHaveBeenCalledTimes(0)
  })
})

describe('RequestHandler.handle — Kiro success path', () => {
  test('selects account, refreshes, sends, returns responseHandler result', async () => {
    const acc = makeAccount({ id: 'A' })
    const sdkResponse = { generateAssistantResponseResponse: {} }
    const finalResponse = new Response('final-sse', {
      headers: { 'Content-Type': 'text/event-stream' }
    })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [sdkResponse],
      responseResult: finalResponse
    })

    const res = await handler.handle(KIRO_URL, { body: JSON.stringify({ model: 'x' }) }, noToast)

    expect(res).toBe(finalResponse)
    expect(fakes.accountSelector.selectHealthyAccount).toHaveBeenCalledTimes(1)
    expect(fakes.tokenRefresher.refreshIfNeeded).toHaveBeenCalledTimes(1)
    expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
    expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(1)
    expect(fakes.responseHandler.handleSdkSuccess).toHaveBeenCalledTimes(1)
    // handleSdkSuccess is fed the SDK response + resolved model/conversationId/streaming.
    const args = fakes.responseHandler.handleSdkSuccess.mock.calls[0]!
    expect(args[0]).toBe(sdkResponse)
    expect(args[2]).toBe('c1')
    expect(args[3]).toBe(false)
  })

  test('token refresh signalling shouldContinue re-selects before sending', async () => {
    const acc = makeAccount({ id: 'A' })
    const refreshed = makeAccount({ id: 'A', accessToken: 'fresh' })
    // Run any sleep() synchronously so the 500ms wait does not stall the test.
    globalThis.setTimeout = ((fn: any) => {
      fn()
      return 0 as any
    }) as any

    const { handler, fakes } = buildHandler({
      selectResults: [acc, refreshed],
      sdkResults: [{ generateAssistantResponseResponse: {} }]
    })
    fakes.tokenRefresher.refreshIfNeeded = mock(async (a: ManagedAccount) => {
      // First call: force a re-loop; second call: proceed.
      if (a === acc) return { shouldContinue: true, account: refreshed }
      return { shouldContinue: false, account: a }
    })
    ;(handler as any).tokenRefresher = fakes.tokenRefresher

    await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    expect(fakes.accountSelector.selectHealthyAccount).toHaveBeenCalledTimes(2)
    expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
  })
})

describe('RequestHandler.handle — error retry / switch', () => {
  test('an HTTP error that requests switchAccount retries with a fresh account', async () => {
    const acc1 = makeAccount({ id: 'A' })
    const acc2 = makeAccount({ id: 'B' })
    const httpError: any = new Error('rate limited')
    httpError.$metadata = { httpStatusCode: 429 }
    httpError.name = 'ThrottlingException'
    const good = { generateAssistantResponseResponse: {} }

    const { handler, fakes } = buildHandler({
      selectResults: [acc1, acc2],
      sdkResults: [httpError, good],
      errorHandleResults: [{ shouldRetry: true, switchAccount: true }]
    })

    const res = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    expect(res).toBeInstanceOf(Response)
    expect(fakes.errorHandler.handle).toHaveBeenCalledTimes(1)
    // The mock Response handed to the error handler carries the SDK http status.
    const mockResp = fakes.errorHandler.handle.mock.calls[0]![1] as Response
    expect(mockResp.status).toBe(429)
    expect(fakes.accountSelector.selectHealthyAccount).toHaveBeenCalledTimes(2)
    expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
  })

  test('a network error (no $metadata) routes to handleNetworkError and rethrows when not retryable', async () => {
    const acc = makeAccount({ id: 'A' })
    const netErr = new Error('fetch failed: ECONNRESET')

    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [netErr]
    })

    await expect(handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)).rejects.toThrow(
      'fetch failed'
    )
    expect(fakes.errorHandler.handleNetworkError).toHaveBeenCalledTimes(1)
    expect(fakes.errorHandler.handle).toHaveBeenCalledTimes(0)
  })

  test('an HTTP error that is not retryable throws Kiro Error: <status>', async () => {
    const acc = makeAccount({ id: 'A' })
    const httpError: any = new Error('bad request')
    httpError.$metadata = { httpStatusCode: 400 }

    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [httpError],
      errorHandleResults: [{ shouldRetry: false }]
    })

    await expect(handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)).rejects.toThrow(
      'Kiro Error: 400'
    )
    expect(fakes.errorHandler.handle).toHaveBeenCalledTimes(1)
  })
})

describe('RequestHandler.handle — re-auth path', () => {
  test('all-permanently-unhealthy triggers reauth via the client, then proceeds on success', async () => {
    const dead = makeAccount({ id: 'A', isHealthy: false, unhealthyReason: 'HTTP_403' })
    const revived = makeAccount({ id: 'A' })

    const authorize = mock(async () => {})
    const callback = mock(async () => {})
    const invalidateCache = mock(() => {})
    const findAll = mock(async () => [revived])
    const client = { provider: { oauth: { authorize, callback } } }

    const accounts = [dead]
    const accountManager: any = {
      getAccounts: mock(() => accounts),
      addAccount: mock((a: ManagedAccount) => {
        accounts.length = 0
        accounts.push(a)
      }),
      toAuthDetails: mock((acc: ManagedAccount) => ({
        access: acc.accessToken,
        refresh: acc.refreshToken,
        expires: acc.expiresAt,
        authMethod: 'idc',
        region: acc.region,
        email: acc.email
      }))
    }
    const repository: any = { save: mock(async () => {}), invalidateCache, findAll }

    const handler = new RequestHandler(accountManager, baseConfig, repository, client)
    const h = handler as any
    const sdkSend = mock(async () => ({ generateAssistantResponseResponse: {} }))
    h.accountSelector = { selectHealthyAccount: mock(async () => revived) }
    h.tokenRefresher = {
      refreshIfNeeded: mock(async (a: ManagedAccount) => ({ shouldContinue: false, account: a }))
    }
    h.errorHandler = { handle: mock(async () => ({ shouldRetry: false })) }
    h.responseHandler = { handleSdkSuccess: mock(async () => new Response('ok')) }
    h.usageTracker = { syncUsage: mock(() => {}) }
    h.makeSdkClient = () => ({ send: sdkSend })
    h.prepareSdkRequest = () => cannedPrep()

    const res = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    expect(res).toBeInstanceOf(Response)
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(invalidateCache).toHaveBeenCalledTimes(1)
    expect(sdkSend).toHaveBeenCalledTimes(1)
  })

  test('all-permanently-unhealthy with no client throws the re-auth-required error', async () => {
    const dead = makeAccount({ id: 'A', isHealthy: false, unhealthyReason: 'HTTP_403' })
    const accountManager: any = {
      getAccounts: mock(() => [dead]),
      toAuthDetails: mock(() => ({}))
    }
    const handler = new RequestHandler(accountManager, baseConfig, {
      save: mock(async () => {})
    } as any)

    await expect(handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)).rejects.toThrow(
      'permanently unhealthy'
    )
  })

  test('a "reauth required" selection error with no client throws the unhealthy/rate-limited error', async () => {
    const accountManager: any = {
      getAccounts: mock(() => []),
      toAuthDetails: mock(() => ({}))
    }
    const handler = new RequestHandler(accountManager, baseConfig, {
      save: mock(async () => {})
    } as any)
    const h = handler as any
    h.accountSelector = {
      selectHealthyAccount: mock(async () => {
        throw new Error('reauth required')
      })
    }

    await expect(handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)).rejects.toThrow(
      'unhealthy or rate-limited'
    )
  })
})

describe('RequestHandler.handle — API request logging', () => {
  test('with enable_log_api_request the success path logs request + response and still returns', async () => {
    const acc = makeAccount({ id: 'A' })
    const logConfig = {
      ...baseConfig,
      enable_log_api_request: true,
      enable_log_effort_debug: true
    }
    const accountManager: any = {
      getAccounts: mock(() => [acc]),
      toAuthDetails: mock(() => ({ access: acc.accessToken, region: acc.region, email: acc.email }))
    }
    const handler = new RequestHandler(accountManager, logConfig, {
      save: mock(async () => {})
    } as any)
    const h = handler as any
    const sdkSend = mock(async () => ({ generateAssistantResponseResponse: {} }))
    h.accountSelector = { selectHealthyAccount: mock(async () => acc) }
    h.tokenRefresher = {
      refreshIfNeeded: mock(async (a: ManagedAccount) => ({ shouldContinue: false, account: a }))
    }
    h.errorHandler = { handle: mock(async () => ({ shouldRetry: false })) }
    h.responseHandler = { handleSdkSuccess: mock(async () => new Response('ok')) }
    h.usageTracker = { syncUsage: mock(() => {}) }
    h.makeSdkClient = () => ({ send: sdkSend })
    h.prepareSdkRequest = () => cannedPrep()

    const res = await handler.handle(KIRO_URL, { body: JSON.stringify({ messages: [] }) }, noToast)
    expect(res).toBeInstanceOf(Response)
    expect(sdkSend).toHaveBeenCalledTimes(1)
  })

  test('with enable_log_api_request the error path logs the SDK error before rethrowing', async () => {
    const acc = makeAccount({ id: 'A' })
    const httpError: any = new Error('bad request')
    httpError.$metadata = { httpStatusCode: 400 }
    const accountManager: any = {
      getAccounts: mock(() => [acc]),
      toAuthDetails: mock(() => ({ access: acc.accessToken, region: acc.region, email: acc.email }))
    }
    const handler = new RequestHandler(
      accountManager,
      { ...baseConfig, enable_log_api_request: true },
      { save: mock(async () => {}) } as any
    )
    const h = handler as any
    h.accountSelector = { selectHealthyAccount: mock(async () => acc) }
    h.tokenRefresher = {
      refreshIfNeeded: mock(async (a: ManagedAccount) => ({ shouldContinue: false, account: a }))
    }
    h.errorHandler = { handle: mock(async () => ({ shouldRetry: false })) }
    h.responseHandler = { handleSdkSuccess: mock(async () => new Response('ok')) }
    h.usageTracker = { syncUsage: mock(() => {}) }
    h.makeSdkClient = () => ({
      send: mock(async () => {
        throw httpError
      })
    })
    h.prepareSdkRequest = () => cannedPrep()

    await expect(handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)).rejects.toThrow(
      'Kiro Error: 400'
    )
  })
})

describe('RequestHandler.handle — circuit breaker', () => {
  test('exceeding max_request_iterations throws the retry-strategy error', async () => {
    const acc = makeAccount({ id: 'A' })
    globalThis.setTimeout = ((fn: any) => {
      fn()
      return 0 as any
    }) as any

    // selectHealthyAccount always returns null -> consecutiveNullAccounts loop,
    // bounded by max_request_iterations from RetryStrategy.
    const { handler } = buildHandler({
      accounts: [],
      selectResults: []
    })
    ;(handler as any).accountSelector = {
      selectHealthyAccount: mock(async () => null)
    }

    await expect(handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)).rejects.toThrow(
      'Exceeded max iterations'
    )
  })
})
