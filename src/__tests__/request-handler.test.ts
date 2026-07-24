import { afterEach, describe, expect, mock, test } from 'bun:test'
import { RequestHandler } from '../core/request/request-handler.js'
import { ResponseHandler } from '../core/request/response-handler.js'
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

function cannedPrep(streaming = false): SdkPreparedRequest {
  return {
    conversationState: { chatTriggerType: 'MANUAL', conversationId: 'c1' } as any,
    profileArn: 'arn:aws:test',
    streaming,
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
  accountSelector: {
    selectHealthyAccount: ReturnType<typeof mock>
    selectAlternativeAccount: ReturnType<typeof mock>
  }
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
  streaming?: boolean
  useRealResponseHandler?: boolean
  alternativeAccount?: ManagedAccount | null
  requestTimeoutMs?: number
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
    }),
    selectAlternativeAccount: mock(async () => opts.alternativeAccount ?? null)
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
  const responseHandler = opts.useRealResponseHandler
    ? { handleSdkSuccess: mock(new ResponseHandler().handleSdkSuccess.bind(new ResponseHandler())) }
    : {
        handleSdkSuccess: mock(
          async (
            _sdkResponse: unknown,
            _model: string,
            _conversationId: string,
            _streaming: boolean,
            lifecycle?: { onComplete?: () => void }
          ) => {
            lifecycle?.onComplete?.()
            return opts.responseResult ?? new Response('ok')
          }
        )
      }
  const usageTracker = { syncUsage: mock(() => {}) }

  const sdkSend = mock(async () => {
    const next = sdkQueue.shift()
    if (next instanceof Error) throw next
    return next ?? {}
  })

  const handler = new RequestHandler(
    accountManager,
    { ...baseConfig, request_timeout_ms: opts.requestTimeoutMs ?? baseConfig.request_timeout_ms },
    repository
  )
  const h = handler as any
  h.accountSelector = accountSelector
  h.tokenRefresher = tokenRefresher
  h.errorHandler = errorHandler
  h.responseHandler = responseHandler
  h.usageTracker = usageTracker
  h.makeSdkClient = () => ({ send: sdkSend })
  h.prepareSdkRequest = () => cannedPrep(opts.streaming)

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

function sdkStream(events: unknown[], error?: Error): object {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
      if (error) throw error
    })()
  }
}

function installImmediateStreamBackoff(handler: RequestHandler): void {
  const internals = handler as unknown as {
    streamRetryRandom: () => number
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  }
  internals.streamRetryRandom = () => 0
  internals.sleep = async (_ms, signal) => {
    if (signal?.aborted) throw signal.reason
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

describe('RequestHandler.handle — SDK event-stream retry boundary', () => {
  test('retries two pre-output failures and exposes only the successful attempt', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream([], new Error('decode-1')),
        sdkStream([], new Error('decode-2')),
        sdkStream([{ assistantResponseEvent: { content: 'successful response' } }])
      ],
      streaming: true,
      useRealResponseHandler: true
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const body = await response.text()
    const streamedContent = body
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)).choices?.[0]?.delta?.content ?? '')
      .join('')

    expect(fakes.sdkSend).toHaveBeenCalledTimes(3)
    expect(streamedContent).toBe('successful response')
    expect(body).not.toContain('decode-1')
    expect(fakes.errorHandler.handle).toHaveBeenCalledTimes(0)
    expect(fakes.errorHandler.handleNetworkError).toHaveBeenCalledTimes(0)
  })

  test('retry 1 reuses A and retry 2 selects healthy alternative B', async () => {
    const a = makeAccount({ id: 'A' })
    const b = makeAccount({ id: 'B' })
    const { handler, fakes } = buildHandler({
      accounts: [a, b],
      selectResults: [a],
      alternativeAccount: b,
      sdkResults: [
        sdkStream([], new Error('decode-1')),
        sdkStream([], new Error('decode-2')),
        sdkStream([{ assistantResponseEvent: { content: 'from B successfully' } }])
      ],
      streaming: true,
      useRealResponseHandler: true
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    await response.text()

    expect(fakes.accountSelector.selectHealthyAccount).toHaveBeenCalledTimes(1)
    expect(fakes.accountSelector.selectAlternativeAccount).toHaveBeenCalledTimes(1)
    expect(
      fakes.accountManager.toAuthDetails.mock.calls.map((call: [ManagedAccount]) => call[0].id)
    ).toEqual(['A', 'A', 'B'])
  })

  test('exhaustion returns a structured retryable HTTP 503', async () => {
    const acc = makeAccount({ id: 'A' })
    const metadataError = new Error('HTTP 200 internal stream error') as Error & {
      $metadata: { httpStatusCode: number }
    }
    metadataError.$metadata = { httpStatusCode: 200 }
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream([], metadataError),
        sdkStream([], metadataError),
        sdkStream([], metadataError)
      ],
      streaming: true,
      useRealResponseHandler: true
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      retryable: true,
      phase: 'stream',
      emittedOutput: false,
      code: 'UPSTREAM_UNEXPECTED'
    })
    expect(fakes.sdkSend).toHaveBeenCalledTimes(3)
    expect(fakes.errorHandler.handle).toHaveBeenCalledTimes(0)
  })

  test('post-output iterator failure is not replayed', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream(
          [{ reasoningContentEvent: { text: 'visible before failure' } }],
          new Error('late decode')
        )
      ],
      streaming: true,
      useRealResponseHandler: true
    })

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('visible before failure')
    await expect(reader.read()).rejects.toMatchObject({
      name: 'UpstreamUnexpectedError',
      retryable: true,
      phase: 'stream',
      emittedOutput: true,
      code: 'UPSTREAM_UNEXPECTED'
    })
    expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
    expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(0)
  })

  test('success bookkeeping waits for full stream completion', async () => {
    const acc = makeAccount({ id: 'A', failCount: 2, unhealthyReason: 'transient' })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const deferredResponse = {
      generateAssistantResponseResponse: (async function* () {
        yield { reasoningContentEvent: { text: 'first semantic output' } }
        await gate
      })()
    }
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [deferredResponse],
      streaming: true,
      useRealResponseHandler: true
    })

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    expect(acc.failCount).toBe(2)
    expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(0)

    const reading = response.text()
    release()
    await reading
    expect(acc.failCount).toBe(0)
    expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(1)
  })

  test('an empty successful stream completes and marks the account successful once', async () => {
    const acc = makeAccount({ id: 'A', failCount: 2, unhealthyReason: 'transient' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [sdkStream([])],
      streaming: true,
      useRealResponseHandler: true
    })

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    expect(await response.text()).toContain('"finish_reason":"stop"')
    expect(acc.failCount).toBe(0)
    expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(1)
  })

  test('a newer failed attempt invalidates an older stream completion on the same account', async () => {
    const acc = makeAccount({ id: 'A', failCount: 2, unhealthyReason: 'transient' })
    let releaseOldStream!: () => void
    const oldStreamGate = new Promise<void>((resolve) => {
      releaseOldStream = resolve
    })
    const newerError = new Error('newer request failed') as Error & {
      $metadata: { httpStatusCode: number }
    }
    newerError.$metadata = { httpStatusCode: 400 }
    const { handler, fakes } = buildHandler({
      selectResults: [acc, acc],
      sdkResults: [
        {
          generateAssistantResponseResponse: (async function* () {
            yield { reasoningContentEvent: { text: 'old output' } }
            await oldStreamGate
          })()
        },
        newerError
      ],
      errorHandleResults: [{ shouldRetry: false }],
      streaming: true,
      useRealResponseHandler: true
    })

    const oldResponse = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const oldReader = oldResponse.body!.getReader()
    await oldReader.read()
    const newerResponse = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    expect(newerResponse.status).toBe(400)

    releaseOldStream()
    while (!(await oldReader.read()).done) {}

    expect(acc.failCount).toBe(2)
    expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(0)
  })

  test('non-streaming iteration failures use the same pre-output retry policy', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream([], new Error('decode-1')),
        sdkStream([], new Error('decode-2')),
        sdkStream([{ assistantResponseEvent: { content: 'non-stream success' } }])
      ],
      useRealResponseHandler: true
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const body = await response.json()

    expect(body.choices[0].message.content).toBe('non-stream success')
    expect(fakes.sdkSend).toHaveBeenCalledTimes(3)
  })

  test('a stream iteration error carrying HTTP 403 never enters HTTP handling', async () => {
    const acc = makeAccount({ id: 'A' })
    const metadataError = new Error('stream decode with embedded forbidden') as Error & {
      $metadata: { httpStatusCode: number }
    }
    metadataError.$metadata = { httpStatusCode: 403 }
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream([], metadataError),
        sdkStream([], metadataError),
        sdkStream([], metadataError)
      ],
      streaming: true,
      useRealResponseHandler: true
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    expect(response.status).toBe(503)
    expect(fakes.sdkSend).toHaveBeenCalledTimes(3)
    expect(fakes.errorHandler.handle).toHaveBeenCalledTimes(0)
  })

  test('a network-looking transformation error bypasses retry handlers and is not replayed', async () => {
    const acc = makeAccount({ id: 'A' })
    const malformedEvent = {
      get reasoningContentEvent() {
        throw new Error('fetch failed while transforming an already-read event')
      }
    }
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [sdkStream([malformedEvent])],
      streaming: true,
      useRealResponseHandler: true
    })

    await expect(handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)).rejects.toThrow(
      'fetch failed while transforming'
    )
    expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
    expect(fakes.errorHandler.handleNetworkError).toHaveBeenCalledTimes(0)
  })

  test('stream retry jitter stays inside the documented bounds', () => {
    const { handler } = buildHandler({})
    const internals = handler as unknown as {
      streamRetryRandom: () => number
      getStreamRetryDelay: (failureCount: number) => number
    }

    internals.streamRetryRandom = () => 0
    expect(internals.getStreamRetryDelay(1)).toBe(250)
    expect(internals.getStreamRetryDelay(2)).toBe(500)
    internals.streamRetryRandom = () => 1
    expect(internals.getStreamRetryDelay(1)).toBe(312.5)
    expect(internals.getStreamRetryDelay(2)).toBe(625)
  })
})

describe('RequestHandler.handle — cancellation and queue release', () => {
  test('inbound abort interrupts a pending send without retry and releases the next request', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler, fakes } = buildHandler({ selectResults: [acc, acc] })
    const internals = handler as unknown as {
      makeSdkClient: () => {
        send: (command: unknown, options: { abortSignal: AbortSignal }) => Promise<object>
      }
    }
    let sendCalls = 0
    let notifyFirstSendStarted!: () => void
    const firstSendStarted = new Promise<void>((resolve) => {
      notifyFirstSendStarted = resolve
    })
    internals.makeSdkClient = () => ({
      send: async (_command, options) => {
        sendCalls++
        if (sendCalls === 2) return { generateAssistantResponseResponse: {} }
        notifyFirstSendStarted()
        return new Promise<object>((_resolve, reject) => {
          options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason), {
            once: true
          })
        })
      }
    })
    const controller = new AbortController()
    const first = handler.handle(
      KIRO_URL,
      { body: JSON.stringify({}), signal: controller.signal },
      noToast
    )
    await firstSendStarted
    const second = handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    controller.abort(new DOMException('cancelled by caller', 'AbortError'))

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(await second).toBeInstanceOf(Response)
    expect(sendCalls).toBe(2)
    expect(fakes.errorHandler.handleNetworkError).toHaveBeenCalledTimes(0)
  })

  test('active timeout interrupts a pending send and releases the next queued request', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc, acc],
      requestTimeoutMs: 20
    })
    const internals = handler as unknown as {
      makeSdkClient: () => {
        send: (command: unknown, options: { abortSignal: AbortSignal }) => Promise<object>
      }
    }
    let sendCalls = 0
    internals.makeSdkClient = () => ({
      send: async (_command, options) => {
        sendCalls++
        if (sendCalls === 2) return { generateAssistantResponseResponse: {} }
        return new Promise<object>((_resolve, reject) => {
          options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason), {
            once: true
          })
        })
      }
    })

    const first = handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const second = handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    await expect(first).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(await second).toBeInstanceOf(Response)
    expect(sendCalls).toBe(2)
    expect(fakes.errorHandler.handleNetworkError).toHaveBeenCalledTimes(0)
  })

  test('active timeout interrupts stream retry backoff without issuing another SDK request', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [sdkStream([], new Error('decode before timeout'))],
      streaming: true,
      useRealResponseHandler: true,
      requestTimeoutMs: 20
    })

    await expect(
      handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
  })

  test('periodic upstream activity allows a thinking stream to outlive the timeout window', async () => {
    const acc = makeAccount({ id: 'A' })
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const sdkResponse = {
      generateAssistantResponseResponse: (async function* () {
        yield { reasoningContentEvent: { text: 'first thought' } }
        await delay(100)
        yield { reasoningContentEvent: { text: 'second thought' } }
        await delay(100)
        yield { assistantResponseEvent: { content: 'final answer' } }
      })()
    }
    const { handler } = buildHandler({
      selectResults: [acc],
      sdkResults: [sdkResponse],
      streaming: true,
      useRealResponseHandler: true,
      requestTimeoutMs: 150
    })

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const body = await response.text()

    expect(body).toContain('first thought')
    expect(body).toContain('second thought')
    expect(body).toContain('final answer')
  })

  test('an idle thinking stream still times out after the configured inactivity window', async () => {
    const acc = makeAccount({ id: 'A' })
    let returnCalls = 0
    let yielded = false
    const sdkResponse = {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              if (!yielded) {
                yielded = true
                return {
                  done: false,
                  value: { reasoningContentEvent: { text: 'first thought' } }
                }
              }
              return new Promise<IteratorResult<unknown>>(() => {})
            },
            async return(): Promise<IteratorResult<unknown>> {
              returnCalls++
              return { done: true, value: undefined }
            }
          }
        }
      }
    }
    const { handler } = buildHandler({
      selectResults: [acc],
      sdkResults: [sdkResponse],
      streaming: true,
      useRealResponseHandler: true,
      requestTimeoutMs: 20
    })

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const reader = response.body!.getReader()

    expect(new TextDecoder().decode((await reader.read()).value)).toContain('first thought')
    await expect(reader.read()).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(returnCalls).toBeGreaterThanOrEqual(1)
  })

  test('consumer cancellation does not retry or mark the request successful', async () => {
    const acc = makeAccount({ id: 'A', failCount: 2, unhealthyReason: 'transient' })
    let returnCalls = 0
    let emitted = false
    const sdkResponse = {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              if (!emitted) {
                emitted = true
                return {
                  done: false,
                  value: { reasoningContentEvent: { text: 'first output' } }
                }
              }
              return new Promise<IteratorResult<unknown>>(() => {})
            },
            async return(): Promise<IteratorResult<unknown>> {
              returnCalls++
              return { done: true, value: undefined }
            }
          }
        }
      }
    }
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [sdkResponse],
      streaming: true,
      useRealResponseHandler: true
    })

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel('consumer stopped')

    expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
    expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(0)
    expect(acc.failCount).toBe(2)
    expect(returnCalls).toBeGreaterThanOrEqual(1)
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

  test('a non-retryable 400 overflow body resolves to a 413 Response with the body preserved', async () => {
    const acc = makeAccount({ id: 'A' })
    const httpError: any = new Error('Input is too long.')
    httpError.name = 'ValidationException'
    httpError.$metadata = { httpStatusCode: 400 }

    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [httpError],
      errorHandleResults: [{ shouldRetry: false }]
    })

    const res = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    expect(res).toBeInstanceOf(Response)
    // 400 "Input is too long." remaps to 413 -> OpenCode context_overflow -> auto-compact.
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.message).toBe('Input is too long.')
    expect(body.__type).toBe('ValidationException')
    expect(fakes.errorHandler.handle).toHaveBeenCalledTimes(1)
  })

  test('a non-retryable, non-overflow 400 resolves to a 400 Response with the body preserved', async () => {
    const acc = makeAccount({ id: 'A' })
    const httpError: any = new Error('Invalid model. Please select a different model to continue.')
    httpError.name = 'ValidationException'
    httpError.$metadata = { httpStatusCode: 400 }

    const { handler } = buildHandler({
      selectResults: [acc],
      sdkResults: [httpError],
      errorHandleResults: [{ shouldRetry: false }]
    })

    const res = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.message).toBe('Invalid model. Please select a different model to continue.')
  })

  test('a terminal 402 resolves to a 402 Response with a readable preserved body', async () => {
    const acc = makeAccount({ id: 'A' })
    const httpError: any = new Error('Monthly request limit reached')
    httpError.name = 'PaymentRequired'
    httpError.$metadata = { httpStatusCode: 402 }

    const { handler } = buildHandler({
      selectResults: [acc],
      sdkResults: [httpError],
      errorHandleResults: [{ shouldRetry: false }]
    })

    const res = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.message).toBe('Monthly request limit reached')
  })

  test('a retry-exhausted 403 resolves to a 403 Response with a readable preserved body', async () => {
    const acc = makeAccount({ id: 'A' })
    const httpError: any = new Error('Forbidden')
    httpError.name = 'AccessDeniedException'
    httpError.$metadata = { httpStatusCode: 403 }

    const { handler } = buildHandler({
      selectResults: [acc],
      sdkResults: [httpError],
      errorHandleResults: [{ shouldRetry: false }]
    })

    const res = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.message).toBe('Forbidden')
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

  test('with enable_log_api_request the terminal error path returns a preserved-body Response', async () => {
    const acc = makeAccount({ id: 'A' })
    const httpError: any = new Error('bad request')
    httpError.name = 'ValidationException'
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

    const res = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.message).toBe('bad request')
  })
})

describe('RequestHandler.handle — circuit breaker', () => {
  test('exceeding max_request_iterations throws the retry-strategy error', async () => {
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
