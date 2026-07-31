import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { TokenRefresher } from '../core/auth/token-refresher.js'
import {
  RequestHandler,
  STREAM_MISSING_COMPLETION_LOG,
  STREAM_REQUEST_STARTED_LOG
} from '../core/request/request-handler.js'
import { ResponseHandler, type SdkResponseLifecycle } from '../core/request/response-handler.js'
import { SdkEventStreamIterationError } from '../core/request/stream-error.js'
import { encodeRefreshToken } from '../kiro/auth.js'
import { AccountManager } from '../plugin/accounts.js'
import * as logger from '../plugin/logger.js'
import { reasoningCorrelationCache } from '../plugin/reasoning/correlation-cache.js'
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
  stream_event_timeout_enabled: false,
  stream_buffer_until_complete: false,
  stream_max_attempts: 3,
  stream_recovery_mode: 'off',
  sdk_response_timeout_enabled: false,
  sdk_response_timeout_ms: 300000,
  sdk_http_keep_alive: false,
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
  responseHandler: {
    handleSdkSuccess: ReturnType<typeof mock>
    prepareSdkStreamingAttempt?: ReturnType<typeof mock>
  }
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
  streamEventTimeoutEnabled?: boolean
  streamBufferUntilComplete?: boolean
  streamMaxAttempts?: number
  streamRecoveryMode?: 'off' | 'reasoning_restart' | 'exact_replay'
  maxRequestIterations?: number
  sdkResponseTimeoutEnabled?: boolean
  sdkResponseTimeoutMs?: number
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
  const realResponseHandler = new ResponseHandler()
  const responseHandler = opts.useRealResponseHandler
    ? {
        handleSdkSuccess: mock(realResponseHandler.handleSdkSuccess.bind(realResponseHandler)),
        prepareSdkStreamingAttempt: mock(
          realResponseHandler.prepareSdkStreamingAttempt.bind(realResponseHandler)
        )
      }
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
    {
      ...baseConfig,
      max_request_iterations: opts.maxRequestIterations ?? baseConfig.max_request_iterations,
      request_timeout_ms: opts.requestTimeoutMs ?? baseConfig.request_timeout_ms,
      stream_event_timeout_enabled:
        opts.streamEventTimeoutEnabled ?? baseConfig.stream_event_timeout_enabled,
      stream_buffer_until_complete:
        opts.streamBufferUntilComplete ?? baseConfig.stream_buffer_until_complete,
      stream_max_attempts: opts.streamMaxAttempts ?? baseConfig.stream_max_attempts,
      stream_recovery_mode: opts.streamRecoveryMode ?? 'off',
      sdk_response_timeout_enabled:
        opts.sdkResponseTimeoutEnabled ?? baseConfig.sdk_response_timeout_enabled,
      sdk_response_timeout_ms: opts.sdkResponseTimeoutMs ?? baseConfig.sdk_response_timeout_ms
    },
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

function streamedText(body: string): string {
  return body
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)).choices?.[0]?.delta?.content ?? '')
    .join('')
}

function sseFrames(body: string): Array<Record<string, any>> {
  const raw = body.split('\n\n')
  expect(raw.at(-1)).toBe('')
  return raw.slice(0, -1).map((frame) => {
    expect(frame.startsWith('data: ')).toBe(true)
    return JSON.parse(frame.slice('data: '.length)) as Record<string, any>
  })
}

function joinedDelta(
  frames: Array<Record<string, any>>,
  field: 'content' | 'reasoning_content'
): string {
  return frames.map((frame) => frame.choices?.[0]?.delta?.[field] ?? '').join('')
}

function terminalFrames(frames: Array<Record<string, any>>): Array<Record<string, any>> {
  return frames.filter((frame) => {
    const finish = frame.choices?.[0]?.finish_reason
    return finish !== null && finish !== undefined
  })
}

function records(
  spy: ReturnType<typeof captureLogger>['warn'],
  message: string
): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter((call) => call[0] === message)
    .map((call) => call[1] as Record<string, unknown>)
}

const STREAM_FAILURE_LOG = 'Kiro SDK event stream iteration failed'
const REPLAY_TELEMETRY_LOG = 'Kiro exact replay attempt finished'

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

function captureLogger() {
  const log = spyOn(logger, 'log').mockImplementation(() => {})
  const warn = spyOn(logger, 'warn').mockImplementation(() => {})
  const error = spyOn(logger, 'error').mockImplementation(() => {})
  return {
    log,
    warn,
    error,
    restore() {
      error.mockRestore()
      warn.mockRestore()
      log.mockRestore()
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

describe('RequestHandler.handle — SDK event-stream retry boundary', () => {
  test('logs retrying and recovered outcomes with request, account, and attempt correlation', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream([], new Error('decode before output')),
          sdkStream([{ assistantResponseEvent: { content: 'recovered response' } }])
        ],
        streaming: true,
        useRealResponseHandler: true
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      await response.text()

      expect(logs.warn).toHaveBeenCalledWith(
        'Kiro SDK event stream iteration failed',
        expect.objectContaining({
          outcome: 'retrying',
          conversationId: 'c1',
          account: 'A@example.com',
          accountId: 'A',
          streamAttempt: 1,
          maxStreamAttempts: 3,
          sdkHttpKeepAlive: false,
          processId: process.pid,
          bunVersion: process.versions.bun,
          upstreamEventCount: 0,
          streamElapsedMs: expect.any(Number),
          nextAttempt: 2,
          delayMs: 250,
          nextAccount: 'A@example.com'
        })
      )
      expect(logs.log).toHaveBeenCalledWith(
        'Kiro SDK event stream retry recovered',
        expect.objectContaining({
          outcome: 'recovered',
          conversationId: 'c1',
          account: 'A@example.com',
          accountId: 'A',
          streamAttempt: 2,
          maxStreamAttempts: 3,
          sdkHttpKeepAlive: false,
          processId: process.pid,
          bunVersion: process.versions.bun,
          upstreamEventCount: 0,
          streamElapsedMs: expect.any(Number),
          attempts: 2
        })
      )
    } finally {
      logs.restore()
    }
  })

  test('logs exhausted after three attempts without changing the structured 503 response', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const failure = new Error('persistent stream failure')
      const { handler } = buildHandler({
        selectResults: [acc],
        sdkResults: [sdkStream([], failure), sdkStream([], failure), sdkStream([], failure)],
        streaming: true,
        useRealResponseHandler: true
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

      expect(logs.error).toHaveBeenCalledWith(
        'Kiro SDK event stream iteration failed',
        expect.objectContaining({
          outcome: 'exhausted',
          conversationId: 'c1',
          account: 'A@example.com',
          accountId: 'A',
          streamAttempt: 3,
          maxStreamAttempts: 3,
          attempts: 3
        })
      )
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        retryable: true,
        phase: 'stream',
        emittedOutput: false,
        code: 'UPSTREAM_UNEXPECTED'
      })
    } finally {
      logs.restore()
    }
  })

  test('logs terminated_after_output when reasoning output prevents replay', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream(
            [{ reasoningContentEvent: { text: 'visible reasoning' } }],
            new Error('late stream failure')
          )
        ],
        streaming: true,
        useRealResponseHandler: true
      })

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      const reader = response.body!.getReader()
      await reader.read()
      await expect(reader.read()).rejects.toMatchObject({
        name: 'UpstreamUnexpectedError',
        emittedOutput: true
      })

      expect(logs.error).toHaveBeenCalledWith(
        'Kiro SDK event stream iteration failed',
        expect.objectContaining({
          outcome: 'terminated_after_output',
          conversationId: 'c1',
          account: 'A@example.com',
          accountId: 'A',
          streamAttempt: 1,
          maxStreamAttempts: 3,
          emittedOutput: true
        })
      )
    } finally {
      logs.restore()
    }
  })

  test('logs completion-metadata transport close as ignored without a failure message', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const terminated = new TypeError('terminated', {
        cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      })
      const { handler } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream(
            [
              { assistantResponseEvent: { content: 'complete response' } },
              { metadataEvent: { tokenUsage: { inputTokens: 4, outputTokens: 2 } } }
            ],
            terminated
          )
        ],
        streaming: true,
        useRealResponseHandler: true
      })

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      await response.text()

      expect(logs.log).toHaveBeenCalledWith(
        'Kiro SDK event stream closed after completion metadata',
        expect.objectContaining({
          outcome: 'ignored_after_completion_metadata',
          conversationId: 'c1',
          account: 'A@example.com',
          accountId: 'A',
          streamAttempt: 1,
          maxStreamAttempts: 3
        })
      )
      expect(
        [...logs.log.mock.calls, ...logs.warn.mock.calls, ...logs.error.mock.calls].some(
          (call) => call[0] === 'Kiro SDK event stream iteration failed'
        )
      ).toBe(false)
    } finally {
      logs.restore()
    }
  })

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

  test('buffered mode retries a post-output reset and exposes only the complete attempt', async () => {
    const acc = makeAccount({ id: 'A' })
    const reset = Object.assign(new Error('socket reset after partial output'), {
      code: 'ECONNRESET'
    })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream(
          [
            { reasoningContentEvent: { text: 'discarded partial reasoning' } },
            {
              toolUseEvent: {
                name: 'discarded_tool',
                toolUseId: 'discarded-tool-id',
                input: '{"unsafe":true}',
                stop: true
              }
            }
          ],
          reset
        ),
        sdkStream([
          { reasoningContentEvent: { text: 'complete reasoning' } },
          { assistantResponseEvent: { content: 'complete answer' } }
        ])
      ],
      streaming: true,
      useRealResponseHandler: true,
      streamBufferUntilComplete: true,
      streamMaxAttempts: 5
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const body = await response.text()

    expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
    expect(body).toContain('complete reasoning')
    expect(body).toContain('complete answer')
    expect(body).not.toContain('discarded partial reasoning')
    expect(body).not.toContain('discarded_tool')
    expect(body).not.toContain('discarded-tool-id')
    expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(1)
  })

  test('stream retry exhaustion honors the configured maximum attempts', async () => {
    const acc = makeAccount({ id: 'A' })
    const failure = new Error('persistent stream failure')
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [sdkStream([], failure), sdkStream([], failure)],
      streaming: true,
      useRealResponseHandler: true,
      streamBufferUntilComplete: true,
      streamMaxAttempts: 2
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    expect(response.status).toBe(503)
    expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
  })

  test('transport close after completion metadata finalizes the response successfully', async () => {
    const acc = makeAccount({ id: 'A', failCount: 2, unhealthyReason: 'transient' })
    const socketError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    const terminated = new TypeError('terminated', { cause: socketError })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream(
          [
            {
              assistantResponseEvent: {
                content: 'complete response before the transport closes'
              }
            },
            {
              metadataEvent: {
                tokenUsage: {
                  uncachedInputTokens: 12,
                  outputTokens: 7,
                  totalTokens: 19
                }
              }
            }
          ],
          terminated
        )
      ],
      streaming: true,
      useRealResponseHandler: true
    })

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const body = await response.text()
    const streamedContent = body
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)).choices?.[0]?.delta?.content ?? '')
      .join('')

    expect(streamedContent).toBe('complete response before the transport closes')
    expect(body).toContain('"finish_reason":"stop"')
    expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
    expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(1)
    expect(acc.failCount).toBe(0)
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

  test('an exhausted attempt reports how much of each channel was already emitted', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream(
            [
              { reasoningContentEvent: { text: 'abc' } },
              { assistantResponseEvent: { content: 'hello' } }
            ],
            new Error('buffered stream died')
          )
        ],
        streaming: true,
        useRealResponseHandler: true,
        streamBufferUntilComplete: true,
        streamMaxAttempts: 1
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

      expect(response.status).toBe(503)
      expect(logs.error).toHaveBeenCalledWith(
        'Kiro SDK event stream iteration failed',
        expect.objectContaining({
          outcome: 'exhausted',
          emittedReasoningChars: 3,
          emittedVisibleChars: 5,
          emittedToolCount: 0,
          sawToolIntent: false
        })
      )
    } finally {
      logs.restore()
    }
  })

  test('tool intent before the break is reported even though no tool call was emitted', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream(
            [
              { reasoningContentEvent: { text: 'abc' } },
              { toolUseEvent: { name: 'read_file', toolUseId: 'tool-1', input: '{"path":"/a' } }
            ],
            new Error('died mid tool call')
          )
        ],
        streaming: true,
        useRealResponseHandler: true,
        streamBufferUntilComplete: true,
        streamMaxAttempts: 1
      })
      installImmediateStreamBackoff(handler)

      await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

      expect(logs.error).toHaveBeenCalledWith(
        'Kiro SDK event stream iteration failed',
        expect.objectContaining({
          outcome: 'exhausted',
          emittedReasoningChars: 3,
          emittedVisibleChars: 0,
          emittedToolCount: 0,
          sawToolIntent: true
        })
      )
    } finally {
      logs.restore()
    }
  })

  test('a post-output failure reports the volumes delivered before the break', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream(
            [
              { reasoningContentEvent: { text: 'abc' } },
              { assistantResponseEvent: { content: 'hello' } }
            ],
            new Error('late stream failure')
          )
        ],
        streaming: true,
        useRealResponseHandler: true
      })

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      const reader = response.body!.getReader()
      const drained = (async () => {
        while (!(await reader.read()).done) {}
      })()

      await expect(drained).rejects.toMatchObject({ name: 'UpstreamUnexpectedError' })
      expect(logs.error).toHaveBeenCalledWith(
        'Kiro SDK event stream iteration failed',
        expect.objectContaining({
          outcome: 'terminated_after_output',
          emittedReasoningChars: 3,
          emittedVisibleChars: 5,
          emittedToolCount: 0,
          sawToolIntent: false
        })
      )
    } finally {
      logs.restore()
    }
  })

  test('reasoning-only live failure restarts inside one SSE when recovery is enabled', async () => {
    const acc = makeAccount({ id: 'A', failCount: 2, unhealthyReason: 'transient' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream(
          [{ reasoningContentEvent: { text: 'partial reasoning' } }],
          new Error('reasoning transport reset')
        ),
        sdkStream([
          { reasoningContentEvent: { text: 'complete reasoning' } },
          { assistantResponseEvent: { content: 'complete answer' } },
          {
            metadataEvent: {
              tokenUsage: { uncachedInputTokens: 3, outputTokens: 2, totalTokens: 5 }
            }
          }
        ])
      ],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart'
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const body = await response.text()

    expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
    expect(fakes.accountSelector.selectAlternativeAccount).toHaveBeenCalledTimes(0)
    expect(body).toContain('partial reasoning')
    expect(body).toContain('complete reasoning')
    expect(body).toContain('complete answer')
    expect(body.split('"finish_reason":"stop"')).toHaveLength(2)
    expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(1)
    expect(acc.failCount).toBe(0)
  })

  test('exact replay logs divergence and catch-up volumes without replay content', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream(
            [{ assistantResponseEvent: { content: 'prefix-0123456789' } }],
            new Error('first reset')
          ),
          sdkStream([{ assistantResponseEvent: { content: 'preXix-0123456789' } }]),
          sdkStream([
            { assistantResponseEvent: { content: 'prefix- suffix' } },
            { metadataEvent: { tokenUsage: { outputTokens: 2 } } }
          ])
        ],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'exact_replay'
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      await response.text()

      expect(logs.log).toHaveBeenCalledWith(
        'Kiro exact replay attempt finished',
        expect.objectContaining({
          matchedReasoningChars: 0,
          matchedVisibleChars: 3,
          matchedToolCount: 0,
          divergenceChannel: 'text',
          replayOutcome: 'diverged',
          attempts: 2,
          quotaNote: 'each exact replay attempt consumes one real SDK send'
        })
      )
      expect(logs.log).toHaveBeenCalledWith(
        'Kiro exact replay attempt finished',
        expect.objectContaining({
          matchedReasoningChars: 0,
          matchedVisibleChars: 7,
          matchedToolCount: 0,
          divergenceChannel: 'none',
          replayOutcome: 'caught_up',
          attempts: 3,
          quotaNote: 'each exact replay attempt consumes one real SDK send'
        })
      )
    } finally {
      logs.restore()
    }
  })

  test('the first live recovery reuses its account and a later recovery prefers an alternative', async () => {
    const a = makeAccount({ id: 'A' })
    const b = makeAccount({ id: 'B' })
    const { handler, fakes } = buildHandler({
      accounts: [a, b],
      selectResults: [a],
      alternativeAccount: b,
      sdkResults: [
        sdkStream([{ reasoningContentEvent: { text: 'attempt one' } }], new Error('reset one')),
        sdkStream([{ reasoningContentEvent: { text: 'attempt two' } }], new Error('reset two')),
        sdkStream([
          { assistantResponseEvent: { content: 'from alternative' } },
          { metadataEvent: { tokenUsage: { outputTokens: 1 } } }
        ])
      ],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart'
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    await response.text()

    expect(fakes.accountSelector.selectAlternativeAccount).toHaveBeenCalledTimes(1)
    expect(
      fakes.accountManager.toAuthDetails.mock.calls.map((call: [ManagedAccount]) => call[0].id)
    ).toEqual(['A', 'A', 'A', 'B', 'B'])
  })

  test('visible text makes a live failure ineligible for reasoning restart', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream(
          [{ assistantResponseEvent: { content: 'visible before failure' } }],
          new Error('late text failure')
        ),
        sdkStream([{ assistantResponseEvent: { content: 'must not be sent' } }])
      ],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart'
    })

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const stream = response.body
    if (!stream) throw new Error('expected a streaming response body')
    const reader = stream.getReader()
    let delivered = ''
    const draining = (async () => {
      while (true) {
        const item = await reader.read()
        if (item.done) return
        delivered += new TextDecoder().decode(item.value)
      }
    })()

    await expect(draining).rejects.toMatchObject({
      name: 'UpstreamUnexpectedError',
      emittedOutput: true
    })
    expect(delivered).toContain('visible befo')
    expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
  })

  test('raw tool intent makes a reasoning-only live failure ineligible for restart', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream(
          [
            { reasoningContentEvent: { text: 'reasoning before tool intent' } },
            { toolUseEvent: { name: 'read_file', toolUseId: 'tool-1', input: '{"path":"/a' } }
          ],
          new Error('tool stream failed')
        ),
        sdkStream([{ assistantResponseEvent: { content: 'must not be sent' } }])
      ],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart'
    })

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    await expect(response.text()).rejects.toMatchObject({
      name: 'UpstreamUnexpectedError',
      emittedOutput: true
    })
    expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
  })

  test('healthy reasoning and text without metadata completes without recovery', async () => {
    const acc = makeAccount({ id: 'A', failCount: 2, unhealthyReason: 'transient' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream([
          { reasoningContentEvent: { text: 'complete reasoning' } },
          { assistantResponseEvent: { content: 'complete answer' } }
        ]),
        sdkStream([{ assistantResponseEvent: { content: 'must not be sent' } }])
      ],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart'
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const body = await response.text()

    expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
    expect(body).toContain('complete reasoning')
    expect(streamedText(body)).toBe('complete answer')
    expect(body.split('"finish_reason":"stop"')).toHaveLength(2)
    expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(1)
    expect(acc.failCount).toBe(0)
  })

  test('reasoning restart honors stream_max_attempts across initial and recovery sends', async () => {
    const acc = makeAccount({ id: 'A' })
    const failure = new Error('persistent reasoning failure')
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream([{ reasoningContentEvent: { text: 'attempt one' } }], failure),
        sdkStream([{ reasoningContentEvent: { text: 'attempt two' } }], failure),
        sdkStream([{ assistantResponseEvent: { content: 'must not be sent' } }])
      ],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart',
      streamMaxAttempts: 2
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    await expect(response.text()).rejects.toMatchObject({
      name: 'UpstreamUnexpectedError',
      emittedOutput: true
    })
    expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
  })

  test('reasoning restart consumes RetryStrategy budget before every recovery send', async () => {
    const acc = makeAccount({ id: 'A' })
    const failure = new Error('persistent reasoning failure')
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream([{ reasoningContentEvent: { text: 'attempt one' } }], failure),
        sdkStream([{ reasoningContentEvent: { text: 'attempt two' } }], failure),
        sdkStream([{ assistantResponseEvent: { content: 'must not be sent' } }])
      ],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart',
      streamMaxAttempts: 3,
      maxRequestIterations: 2
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    await expect(response.text()).rejects.toMatchObject({
      name: 'UpstreamUnexpectedError',
      emittedOutput: true
    })
    expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
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

describe('RequestHandler.handle — unconditional stream-start record', () => {
  function startRecords(log: ReturnType<typeof captureLogger>['log']): unknown[][] {
    return log.mock.calls.filter((call) => call[0] === STREAM_REQUEST_STARTED_LOG)
  }

  test('one record is written per inbound request, carrying only correlation fields', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler } = buildHandler({
        selectResults: [acc],
        sdkResults: [sdkStream([{ assistantResponseEvent: { content: 'answer' } }])],
        streaming: true,
        useRealResponseHandler: true
      })

      const response = await handler.handle(
        KIRO_URL,
        { body: JSON.stringify({ model: 'x' }) },
        noToast
      )
      await response.text()

      const records = startRecords(logs.log)
      expect(records).toHaveLength(1)
      expect(records[0]![1]).toEqual({
        conversationId: 'c1',
        model: 'x',
        effectiveModel: 'claude-sonnet-4-5',
        processId: process.pid
      })
    } finally {
      logs.restore()
    }
  })

  test('stream retries within one request add no further records', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream([], new Error('decode-1')),
          sdkStream([], new Error('decode-2')),
          sdkStream([{ assistantResponseEvent: { content: 'third time lucky' } }])
        ],
        streaming: true,
        useRealResponseHandler: true
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      await response.text()

      expect(fakes.sdkSend).toHaveBeenCalledTimes(3)
      expect(startRecords(logs.log)).toHaveLength(1)
    } finally {
      logs.restore()
    }
  })

  test('an account switch driven by an HTTP error adds no further records', async () => {
    const acc1 = makeAccount({ id: 'A' })
    const acc2 = makeAccount({ id: 'B' })
    const httpError: any = new Error('rate limited')
    httpError.$metadata = { httpStatusCode: 429 }
    httpError.name = 'ThrottlingException'
    const logs = captureLogger()
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc1, acc2],
        sdkResults: [httpError, sdkStream([{ assistantResponseEvent: { content: 'from B' } }])],
        errorHandleResults: [{ shouldRetry: true, switchAccount: true }],
        streaming: true,
        useRealResponseHandler: true
      })

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      await response.text()

      expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
      expect(startRecords(logs.log)).toHaveLength(1)
    } finally {
      logs.restore()
    }
  })

  test('a non-streaming request writes no record', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler } = buildHandler({
        selectResults: [acc],
        sdkResults: [sdkStream([{ assistantResponseEvent: { content: 'answer' } }])],
        useRealResponseHandler: true
      })

      await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

      expect(startRecords(logs.log)).toHaveLength(0)
    } finally {
      logs.restore()
    }
  })
})

describe('RequestHandler.handle — clean end without completion metadata', () => {
  test('the marker is logged while the response still finishes exactly as before', async () => {
    const acc = makeAccount({ id: 'A', failCount: 2, unhealthyReason: 'transient' })
    const logs = captureLogger()
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [sdkStream([{ assistantResponseEvent: { content: 'partial answer' } }])],
        streaming: true,
        useRealResponseHandler: true
      })

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      const body = await response.text()
      const streamedContent = body
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice('data: '.length)).choices?.[0]?.delta?.content ?? '')
        .join('')

      expect(streamedContent).toBe('partial answer')
      expect(body).toContain('"finish_reason":"stop"')
      expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(1)
      expect(acc.failCount).toBe(0)
      expect(logs.warn).toHaveBeenCalledWith(
        STREAM_MISSING_COMPLETION_LOG,
        expect.objectContaining({
          outcome: 'clean_eof_without_completion_metadata',
          conversationId: 'c1',
          accountId: 'A',
          streamAttempt: 1,
          emittedReasoningChars: 0,
          emittedVisibleChars: 'partial answer'.length,
          emittedToolCount: 0,
          sawToolIntent: false
        })
      )
    } finally {
      logs.restore()
    }
  })

  test('a stream carrying completion metadata logs no marker', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream([
            { assistantResponseEvent: { content: 'complete answer' } },
            {
              metadataEvent: {
                tokenUsage: { uncachedInputTokens: 3, outputTokens: 2, totalTokens: 5 }
              }
            }
          ])
        ],
        streaming: true,
        useRealResponseHandler: true
      })

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      await response.text()

      expect(logs.warn.mock.calls.some((call) => call[0] === STREAM_MISSING_COMPLETION_LOG)).toBe(
        false
      )
    } finally {
      logs.restore()
    }
  })

  test('the marker also covers a buffered stream that ends without metadata', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler } = buildHandler({
        selectResults: [acc],
        sdkResults: [sdkStream([{ reasoningContentEvent: { text: 'abc' } }])],
        streaming: true,
        useRealResponseHandler: true,
        streamBufferUntilComplete: true
      })

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      const body = await response.text()

      expect(body).toContain('"finish_reason":"stop"')
      expect(logs.warn).toHaveBeenCalledWith(
        STREAM_MISSING_COMPLETION_LOG,
        expect.objectContaining({
          outcome: 'clean_eof_without_completion_metadata',
          emittedReasoningChars: 3,
          emittedVisibleChars: 0,
          streamDeliveryMode: 'buffered'
        })
      )
    } finally {
      logs.restore()
    }
  })
})

describe('RequestHandler.handle — reasoning signature safety gates', () => {
  beforeEach(() => {
    reasoningCorrelationCache.clearAllForTests()
  })

  const signedToolEvents = (label: string): unknown[] => [
    { reasoningContentEvent: { text: `reasoning-${label}` } },
    { reasoningContentEvent: { signature: `signature-${label}` } },
    { assistantResponseEvent: { content: `visible-${label}` } },
    {
      toolUseEvent: {
        name: 'read_file',
        toolUseId: `tool-${label}`,
        input: `{"path":"/${label}"}`
      }
    },
    {
      toolUseEvent: {
        name: 'read_file',
        toolUseId: `tool-${label}`,
        input: '',
        stop: true
      }
    },
    { metadataEvent: { tokenUsage: { outputTokens: 1 } } }
  ]

  const incompleteSignedToolEvents = (label: string): unknown[] => [
    { reasoningContentEvent: { text: `reasoning-${label}` } },
    { reasoningContentEvent: { signature: `signature-${label}` } },
    {
      toolUseEvent: {
        name: 'read_file',
        toolUseId: `tool-${label}`,
        input: `{"path":"/${label}`
      }
    }
  ]

  const signedDialectEvents = (label: string, truncated: boolean): unknown[] => [
    { reasoningContentEvent: { text: `reasoning-${label}` } },
    { reasoningContentEvent: { signature: `signature-${label}` } },
    {
      assistantResponseEvent: {
        content:
          `<invoke name="read_file"><parameter name="path">/${label}</parameter></invoke>` +
          (truncated ? '<invoke name="write_file"><parameter name="path">/truncated' : '')
      }
    }
  ]

  const lookupSignedTool = (label: string) =>
    reasoningCorrelationCache.lookup({
      reasoningText: `reasoning-${label}`,
      visibleText: `visible-${label}`,
      toolUses: [
        {
          toolUseId: `tool-${label}`,
          name: 'read_file',
          argumentsJson: `{"path":"/${label}"}`
        }
      ],
      effectiveModel: 'claude-sonnet-4-5'
    })

  const lookupIncompleteSignedTool = (label: string) =>
    reasoningCorrelationCache.lookup({
      reasoningText: `reasoning-${label}`,
      visibleText: '',
      toolUses: [
        {
          toolUseId: `tool-${label}`,
          name: 'read_file',
          argumentsJson: `{"path":"/${label}`
        }
      ],
      effectiveModel: 'claude-sonnet-4-5'
    })

  for (const mode of ['reasoning_restart', 'exact_replay'] as const) {
    test(`an unclosed signed raw tool intent fails before completion in ${mode}`, async () => {
      const label = `f1-${mode}`
      const acc = makeAccount({ id: 'A', failCount: 4, unhealthyReason: 'transient' })
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [sdkStream(incompleteSignedToolEvents(label))],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: mode,
        streamMaxAttempts: 1
      })

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      const stream = response.body
      if (!stream) throw new Error('expected a streaming response body')
      const reader = stream.getReader()
      let delivered = ''
      const draining = (async () => {
        while (true) {
          const item = await reader.read()
          if (item.done) return
          delivered += new TextDecoder().decode(item.value)
        }
      })()

      await expect(draining).rejects.toMatchObject({
        name: 'UpstreamUnexpectedError',
        cause: {
          name: 'SdkEventStreamIterationError',
          cause: { name: 'SemanticStreamTruncationError' }
        },
        emittedOutput: true
      })
      expect(delivered).not.toContain('"finish_reason":"tool_calls"')
      expect(delivered).not.toContain('"finish_reason":"stop"')
      expect(lookupIncompleteSignedTool(label).refusal).toBe('miss')
      expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(0)
      expect(acc.failCount).toBe(4)
      expect(acc.unhealthyReason).toBe('transient')
    })
  }

  test('off mode preserves the synthetic completion for an unclosed signed raw tool intent', async () => {
    const label = 'f1-off'
    const acc = makeAccount({ id: 'A', failCount: 4, unhealthyReason: 'transient' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [sdkStream(incompleteSignedToolEvents(label))],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'off'
    })

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const body = await response.text()

    expect(body).toContain('"finish_reason":"tool_calls"')
    expect(lookupIncompleteSignedTool(label).envelope).toEqual({
      kind: 'reasoningText',
      text: `reasoning-${label}`,
      signature: `signature-${label}`
    })
    expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(1)
    expect(acc.failCount).toBe(0)
    expect(acc.unhealthyReason).toBeUndefined()
  })

  for (const mode of ['reasoning_restart', 'exact_replay'] as const) {
    test(`a mixed complete and truncated signed dialect fails before completion in ${mode}`, async () => {
      const label = `dialect-${mode}`
      const acc = makeAccount({ id: 'A', failCount: 4, unhealthyReason: 'transient' })
      const publish = spyOn(reasoningCorrelationCache, 'publish')
      try {
        const { handler, fakes } = buildHandler({
          selectResults: [acc],
          sdkResults: [sdkStream(signedDialectEvents(label, true))],
          streaming: true,
          useRealResponseHandler: true,
          streamRecoveryMode: mode,
          streamMaxAttempts: 1
        })

        const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
        const stream = response.body
        if (!stream) throw new Error('expected a streaming response body')
        const reader = stream.getReader()
        let delivered = ''
        const draining = (async () => {
          while (true) {
            const item = await reader.read()
            if (item.done) return
            delivered += new TextDecoder().decode(item.value)
          }
        })()

        await expect(draining).rejects.toMatchObject({
          name: 'UpstreamUnexpectedError',
          cause: {
            name: 'SdkEventStreamIterationError',
            cause: { name: 'SemanticStreamTruncationError' }
          },
          emittedOutput: true
        })
        expect(delivered).not.toContain('"finish_reason":"tool_calls"')
        expect(delivered).not.toContain('"finish_reason":"stop"')
        expect(publish).toHaveBeenCalledTimes(0)
        expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(0)
        expect(acc.failCount).toBe(4)
        expect(acc.unhealthyReason).toBe('transient')
      } finally {
        publish.mockRestore()
      }
    })
  }

  test('off mode preserves mixed dialect emission and completion side effects', async () => {
    const label = 'dialect-off'
    const acc = makeAccount({ id: 'A', failCount: 4, unhealthyReason: 'transient' })
    const publish = spyOn(reasoningCorrelationCache, 'publish')
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [sdkStream(signedDialectEvents(label, true))],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'off'
      })

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      const body = await response.text()

      expect(body).toContain('/truncated')
      expect(body).toContain('"finish_reason":"tool_calls"')
      expect(publish).toHaveBeenCalledTimes(1)
      expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(1)
      expect(acc.failCount).toBe(0)
      expect(acc.unhealthyReason).toBeUndefined()
    } finally {
      publish.mockRestore()
    }
  })

  test('a fully resolved signed dialect keeps the success and publish path intact', async () => {
    const label = 'dialect-complete'
    const acc = makeAccount({ id: 'A', failCount: 4, unhealthyReason: 'transient' })
    const publish = spyOn(reasoningCorrelationCache, 'publish')
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [sdkStream(signedDialectEvents(label, false))],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'reasoning_restart'
      })

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      const body = await response.text()

      expect(body).not.toContain('<invoke')
      expect(body).toContain('"finish_reason":"tool_calls"')
      expect(publish).toHaveBeenCalledTimes(1)
      expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(1)
      expect(acc.failCount).toBe(0)
      expect(acc.unhealthyReason).toBeUndefined()
    } finally {
      publish.mockRestore()
    }
  })

  test('two healthy concurrent requests on one account both publish their envelopes', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler } = buildHandler({
      selectResults: [acc, acc],
      sdkResults: [sdkStream(signedToolEvents('first')), sdkStream(signedToolEvents('second'))],
      streaming: true,
      useRealResponseHandler: true
    })

    const first = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const second = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    await Promise.all([first.text(), second.text()])

    expect(lookupSignedTool('first').envelope).toEqual({
      kind: 'reasoningText',
      text: 'reasoning-first',
      signature: 'signature-first'
    })
    expect(lookupSignedTool('second').envelope).toEqual({
      kind: 'reasoningText',
      text: 'reasoning-second',
      signature: 'signature-second'
    })
  })

  test('recovery mode leaves two healthy concurrent requests on one account publishing', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc, acc],
      sdkResults: [
        sdkStream(signedToolEvents('live-one')),
        sdkStream(signedToolEvents('live-two'))
      ],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart'
    })

    const first = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const second = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    await Promise.all([first.text(), second.text()])

    expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
    expect(lookupSignedTool('live-one').envelope).toEqual({
      kind: 'reasoningText',
      text: 'reasoning-live-one',
      signature: 'signature-live-one'
    })
    expect(lookupSignedTool('live-two').envelope).toEqual({
      kind: 'reasoningText',
      text: 'reasoning-live-two',
      signature: 'signature-live-two'
    })
  })

  test('a recovered tool completion does not publish its final-attempt envelope', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream(
          [{ reasoningContentEvent: { text: 'partial reasoning' } }],
          new Error('late reset')
        ),
        sdkStream(signedToolEvents('recovered'))
      ],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart'
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    await response.text()

    expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
    expect(lookupSignedTool('recovered').refusal).toBe('miss')
  })

  test('a caught-up exact replay publishes its final-attempt envelope', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream(
          [
            { reasoningContentEvent: { text: 'reasoning-exact' } },
            { reasoningContentEvent: { signature: 'signature-exact' } },
            { assistantResponseEvent: { content: 'visible-exact' } }
          ],
          new Error('late reset')
        ),
        sdkStream(signedToolEvents('exact'))
      ],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'exact_replay'
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    await response.text()

    expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
    expect(lookupSignedTool('exact').envelope).toEqual({
      kind: 'reasoningText',
      text: 'reasoning-exact',
      signature: 'signature-exact'
    })
  })

  test('a superseded attempt cannot republish after the recovered final answer clears its loop', async () => {
    const acc = makeAccount({ id: 'A' })
    const loopId = 'loop-superseded-attempt'
    reasoningCorrelationCache.publish({
      envelope: { kind: 'reasoningText', text: 'seed reasoning', signature: 'seed signature' },
      reasoningText: 'seed reasoning',
      visibleText: 'seed visible',
      toolUses: [
        {
          toolUseId: loopId,
          name: 'seed_tool',
          argumentsJson: '{}'
        }
      ],
      effectiveModel: 'claude-sonnet-4-5',
      loopId,
      accountId: acc.id,
      attemptId: 'seed-attempt'
    })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [{}, {}],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart'
    })
    installImmediateStreamBackoff(handler)
    let prepareCalls = 0
    let supersededLifecycle: SdkResponseLifecycle | undefined
    const partialChunk = {
      choices: [{ index: 0, delta: { reasoning_content: 'partial' }, finish_reason: null }]
    }
    const terminalChunk = {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    }
    const prepareSdkStreamingAttempt = mock(
      async (input: { readonly lifecycle: SdkResponseLifecycle }) => {
        prepareCalls++
        if (prepareCalls === 1) {
          supersededLifecycle = input.lifecycle
          let reads = 0
          return {
            chunks: {
              async next(): Promise<IteratorResult<unknown>> {
                reads++
                if (reads === 1) return { done: false, value: partialChunk }
                throw new SdkEventStreamIterationError(new Error('superseded stream failed'))
              }
            },
            observed: () => ({
              emitted: { visibleChars: 0, toolCount: 0 },
              sawToolIntent: false
            }),
            close: async () => {},
            complete: async () => {}
          }
        }

        let reads = 0
        return {
          chunks: {
            async next(): Promise<IteratorResult<unknown>> {
              reads++
              return reads === 1
                ? { done: false, value: terminalChunk }
                : { done: true, value: undefined }
            }
          },
          observed: () => ({
            emitted: { visibleChars: 0, toolCount: 0 },
            sawToolIntent: false
          }),
          close: async () => {},
          complete: async (completion: { readonly recovered: boolean }) => {
            await input.lifecycle.onComplete?.({
              reasoningText: 'final reasoning',
              visibleText: 'final answer',
              toolUses: [],
              attemptId: input.lifecycle.attemptId ?? '',
              loopId,
              effectiveModel: 'claude-sonnet-4-5',
              recovered: completion.recovered
            })
          }
        }
      }
    )
    Object.assign(handler, {
      responseHandler: {
        handleSdkSuccess: fakes.responseHandler.handleSdkSuccess,
        prepareSdkStreamingAttempt
      }
    })

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    await response.text()
    const staleLifecycle = supersededLifecycle
    if (!staleLifecycle) throw new Error('expected the superseded lifecycle to be captured')
    await staleLifecycle.onComplete?.({
      envelope: {
        kind: 'reasoningText',
        text: 'superseded reasoning',
        signature: 'superseded signature'
      },
      reasoningText: 'superseded reasoning',
      visibleText: 'superseded visible',
      toolUses: [
        {
          toolUseId: loopId,
          name: 'stale_tool',
          argumentsJson: '{}'
        }
      ],
      attemptId: staleLifecycle.attemptId ?? '',
      loopId,
      effectiveModel: 'claude-sonnet-4-5',
      recovered: false
    })

    expect(reasoningCorrelationCache.sizeForLoop(loopId)).toBe(0)
    expect(
      reasoningCorrelationCache.lookup({
        reasoningText: 'superseded reasoning',
        visibleText: 'superseded visible',
        toolUses: [
          {
            toolUseId: loopId,
            name: 'stale_tool',
            argumentsJson: '{}'
          }
        ],
        effectiveModel: 'claude-sonnet-4-5'
      }).refusal
    ).toBe('miss')
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

  test('disabled SDK response timeout allows a send to outlive the configured window', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler } = buildHandler({
      selectResults: [acc],
      requestTimeoutMs: 20,
      sdkResponseTimeoutEnabled: false,
      sdkResponseTimeoutMs: 20
    })
    const internals = handler as unknown as {
      makeSdkClient: () => {
        send: (command: unknown, options: { abortSignal: AbortSignal }) => Promise<object>
      }
    }
    internals.makeSdkClient = () => ({
      send: (_command, options) =>
        new Promise<object>((resolve, reject) => {
          const timer = setTimeout(() => resolve({ generateAssistantResponseResponse: {} }), 50)
          options.abortSignal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(options.abortSignal.reason)
            },
            { once: true }
          )
        })
    })

    await expect(
      handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    ).resolves.toBeInstanceOf(Response)
  })

  test('disabled SDK response timeout allows the first stream event to outlive the inactivity window', async () => {
    const acc = makeAccount({ id: 'A' })
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const sdkResponse = {
      generateAssistantResponseResponse: (async function* () {
        await delay(75)
        yield { assistantResponseEvent: { content: 'slow first answer' } }
      })()
    }
    const { handler } = buildHandler({
      selectResults: [acc],
      sdkResults: [sdkResponse],
      streaming: true,
      useRealResponseHandler: true,
      requestTimeoutMs: 20,
      sdkResponseTimeoutEnabled: false,
      sdkResponseTimeoutMs: 20
    })

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const body = await response.text()
    expect(body).toContain('slow fi')
    expect(body).toContain('rst answer')
  })

  test('SDK response timeout interrupts a pending send and releases the next queued request', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc, acc],
      requestTimeoutMs: 1000,
      sdkResponseTimeoutEnabled: true,
      sdkResponseTimeoutMs: 20
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

    const startedAt = Date.now()
    const first = handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const second = handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    await expect(first).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Kiro request timed out waiting for SDK response'
    })
    expect(await second).toBeInstanceOf(Response)
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(sendCalls).toBe(2)
    expect(fakes.errorHandler.handleNetworkError).toHaveBeenCalledTimes(0)
  })

  test('SDK response timeout remains active until the first stream event arrives', async () => {
    const acc = makeAccount({ id: 'A' })
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const sdkResponse = {
      generateAssistantResponseResponse: (async function* () {
        await delay(75)
        yield { assistantResponseEvent: { content: 'too late' } }
      })()
    }
    const { handler } = buildHandler({
      selectResults: [acc],
      sdkResults: [sdkResponse],
      streaming: true,
      useRealResponseHandler: true,
      requestTimeoutMs: 1000,
      sdkResponseTimeoutEnabled: true,
      sdkResponseTimeoutMs: 20
    })

    await expect(
      handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    ).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Kiro request timed out waiting for SDK response'
    })
  })

  test('inbound abort interrupts stream retry backoff without issuing another SDK request', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [sdkStream([], new Error('decode before timeout'))],
      streaming: true,
      useRealResponseHandler: true,
      requestTimeoutMs: 1000
    })
    const internals = handler as unknown as {
      sleep: (ms: number, signal?: AbortSignal) => Promise<void>
    }
    let notifyBackoffStarted!: () => void
    const backoffStarted = new Promise<void>((resolve) => {
      notifyBackoffStarted = resolve
    })
    internals.sleep = async (_ms, signal) => {
      notifyBackoffStarted()
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    const controller = new AbortController()
    const request = handler.handle(
      KIRO_URL,
      { body: JSON.stringify({}), signal: controller.signal },
      noToast
    )

    await backoffStarted
    controller.abort(new DOMException('cancelled during retry backoff', 'AbortError'))

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
  })

  test('inbound abort during reasoning recovery backoff releases the request without another send', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc, acc],
      sdkResults: [
        sdkStream(
          [{ reasoningContentEvent: { text: 'partial reasoning' } }],
          new Error('late reset')
        ),
        sdkStream([
          { assistantResponseEvent: { content: 'next request succeeds' } },
          { metadataEvent: { tokenUsage: { outputTokens: 1 } } }
        ])
      ],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart'
    })
    const internals = handler as unknown as {
      sleep: (ms: number, signal?: AbortSignal) => Promise<void>
    }
    let notifyBackoffStarted: (() => void) | undefined
    const backoffStarted = new Promise<void>((resolve) => {
      notifyBackoffStarted = resolve
    })
    internals.sleep = async (_ms, signal) => {
      notifyBackoffStarted?.()
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    const controller = new AbortController()
    const response = await handler.handle(
      KIRO_URL,
      { body: JSON.stringify({}), signal: controller.signal },
      noToast
    )
    const reading = response.text()

    await backoffStarted
    controller.abort(new DOMException('cancelled during recovery backoff', 'AbortError'))

    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
    const next = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    expect(streamedText(await next.text())).toBe('next request succeeds')
  })

  test('inbound abort interrupts the second recovery send and allows a later request', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler } = buildHandler({
      selectResults: [acc, acc],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart'
    })
    const internals = handler as unknown as {
      makeSdkClient: () => {
        send: (command: unknown, options: { abortSignal: AbortSignal }) => Promise<object>
      }
      sleep: (ms: number, signal?: AbortSignal) => Promise<void>
    }
    let sendCalls = 0
    let notifySecondSendStarted: (() => void) | undefined
    const secondSendStarted = new Promise<void>((resolve) => {
      notifySecondSendStarted = resolve
    })
    internals.sleep = async (_ms, signal) => {
      if (signal?.aborted) throw signal.reason
    }
    internals.makeSdkClient = () => ({
      send: async (_command, options) => {
        sendCalls++
        if (sendCalls === 1) {
          return sdkStream(
            [{ reasoningContentEvent: { text: 'partial reasoning' } }],
            new Error('late reset')
          )
        }
        if (sendCalls === 2) {
          notifySecondSendStarted?.()
          return new Promise<object>((_resolve, reject) => {
            options.abortSignal.addEventListener(
              'abort',
              () => reject(options.abortSignal.reason),
              {
                once: true
              }
            )
          })
        }
        return sdkStream([
          { assistantResponseEvent: { content: 'later request succeeds' } },
          { metadataEvent: { tokenUsage: { outputTokens: 1 } } }
        ])
      }
    })
    const controller = new AbortController()
    const response = await handler.handle(
      KIRO_URL,
      { body: JSON.stringify({}), signal: controller.signal },
      noToast
    )
    const reading = response.text()

    await secondSendStarted
    controller.abort(new DOMException('cancelled during recovery send', 'AbortError'))

    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(sendCalls).toBe(2)
    const next = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    expect(streamedText(await next.text())).toBe('later request succeeds')
    expect(sendCalls).toBe(3)
  })

  test('an initial recovery open failure keeps caller cancellation live for the retried attempt', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler } = buildHandler({
      selectResults: [acc, acc],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart'
    })
    installImmediateStreamBackoff(handler)
    const internals = handler as unknown as {
      makeSdkClient: () => {
        send: (command: unknown, options: { abortSignal: AbortSignal }) => Promise<object>
      }
    }
    let sendCalls = 0
    let retrySignal: AbortSignal | undefined
    let notifyRetrySendStarted: (() => void) | undefined
    const retrySendStarted = new Promise<void>((resolve) => {
      notifyRetrySendStarted = resolve
    })
    internals.makeSdkClient = () => ({
      send: async (_command, options) => {
        sendCalls++
        if (sendCalls === 1) {
          return sdkStream([], new Error('upstream reset before the first event'))
        }
        if (sendCalls === 2) {
          retrySignal = options.abortSignal
          notifyRetrySendStarted?.()
          return new Promise<object>((_resolve, reject) => {
            options.abortSignal.addEventListener(
              'abort',
              () => reject(options.abortSignal.reason),
              { once: true }
            )
          })
        }
        return sdkStream([
          { assistantResponseEvent: { content: 'queued request succeeds' } },
          { metadataEvent: { tokenUsage: { outputTokens: 1 } } }
        ])
      }
    })
    const controller = new AbortController()
    const request = handler.handle(
      KIRO_URL,
      { body: JSON.stringify({}), signal: controller.signal },
      noToast
    )

    await retrySendStarted
    const reason = new DOMException('cancelled during the retried attempt', 'AbortError')
    controller.abort(reason)

    expect(retrySignal?.aborted).toBe(true)
    expect(retrySignal?.reason).toBe(reason)
    const caught = await request.then(
      () => undefined,
      (error: unknown) => error
    )
    expect(caught).toBe(reason)
    expect(sendCalls).toBe(2)

    const next = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    expect(streamedText(await next.text())).toBe('queued request succeeds')
    expect(sendCalls).toBe(3)
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

  test('delayed response consumption does not count as upstream inactivity', async () => {
    const acc = makeAccount({ id: 'A' })
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const { handler } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream([
          { reasoningContentEvent: { text: 'first thought' } },
          { assistantResponseEvent: { content: 'final answer' } }
        ])
      ],
      streaming: true,
      useRealResponseHandler: true,
      requestTimeoutMs: 20
    })

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    await delay(50)

    const body = await response.text()
    expect(body).toContain('first thought')
    expect(body).toContain('final answer')
  })

  test('a silent thinking stream stays caller-cancellable when event timeout is disabled', async () => {
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
    const controller = new AbortController()
    const response = await handler.handle(
      KIRO_URL,
      { body: JSON.stringify({}), signal: controller.signal },
      noToast
    )
    const reader = response.body!.getReader()

    expect(new TextDecoder().decode((await reader.read()).value)).toContain('first thought')
    const pendingRead = reader.read()
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    controller.abort(new DOMException('cancelled by caller', 'AbortError'))

    await expect(pendingRead).rejects.toMatchObject({
      name: 'AbortError',
      message: 'cancelled by caller'
    })
    expect(returnCalls).toBeGreaterThanOrEqual(1)
  })

  test('an opted-in idle thinking stream times out after the inactivity window', async () => {
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
      requestTimeoutMs: 20,
      streamEventTimeoutEnabled: true
    })

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const reader = response.body!.getReader()

    expect(new TextDecoder().decode((await reader.read()).value)).toContain('first thought')
    await expect(reader.read()).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Kiro request timed out waiting for stream event'
    })
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
  test('token persistence failure stays on the refresh retry path and never enters network handling', async () => {
    const acc = makeAccount({
      id: 'persistence',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      expiresAt: Date.now() - 1000
    })
    const manager = new AccountManager([acc], 'sticky')
    let saveCalls = 0
    const repository = {
      invalidateCache: mock(() => {}),
      findAll: mock(async () => [{ ...acc }]),
      save: mock(async () => {
        saveCalls++
        if (saveCalls <= 3) {
          throw new Error('SQLITE_BUSY: database is locked')
        }
      })
    } as any
    const refresh = mock(async () => ({
      access: 'unpersisted-access',
      refresh: encodeRefreshToken({
        refreshToken: 'unpersisted-refresh',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        authMethod: 'idc'
      }),
      expires: Date.now() + 3600000,
      authMethod: 'idc' as const,
      region: 'us-east-1' as const
    }))
    const realRefresher = new TokenRefresher(
      baseConfig,
      manager,
      mock(async () => {}),
      repository,
      {
        refreshAccessToken: refresh,
        sleep: async () => {},
        random: () => 0
      }
    )
    const { handler, fakes } = buildHandler({
      selectResults: [acc, acc],
      sdkResults: [{ generateAssistantResponseResponse: {} }]
    })
    const refreshBackoff = mock(async () => {})
    const internals = handler as any
    internals.tokenRefresher = realRefresher
    internals.sleep = refreshBackoff

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    expect(response).toBeInstanceOf(Response)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(repository.save).toHaveBeenCalledTimes(4)
    expect(refreshBackoff).toHaveBeenCalledWith(500, expect.any(AbortSignal))
    expect(fakes.errorHandler.handleNetworkError).toHaveBeenCalledTimes(0)
    expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
    expect(acc.accessToken).toBe('unpersisted-access')
  })

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

describe('RequestHandler.handle — §9 Tier A recovery fault-injection matrix', () => {
  test('row 1: a pre-output failure in recovery mode stays on the legacy retry path', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream([], new Error('pre-output decode failure')),
          sdkStream([
            { assistantResponseEvent: { content: 'second attempt answer' } },
            { metadataEvent: { tokenUsage: { outputTokens: 1 } } }
          ])
        ],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'reasoning_restart'
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      const frames = sseFrames(await response.text())

      expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
      expect(frames.map((frame) => frame.choices?.[0]?.delta?.content ?? '').join('')).toBe(
        'second attempt answer'
      )
      expect(frames.filter((frame) => frame.choices?.[0]?.finish_reason !== null)).toHaveLength(1)

      const retrying = records(logs.warn, STREAM_FAILURE_LOG)
      expect(retrying).toHaveLength(1)
      expect(retrying[0]).toMatchObject({
        outcome: 'retrying',
        emittedReasoningChars: 0,
        emittedVisibleChars: 0
      })
      // The legacy pre-output retry is the only path that attaches the failure
      // cause to its `retrying` record; the coordinator's backoff never does.
      expect(retrying[0]!['error']).toMatchObject({
        name: 'SdkEventStreamIterationError',
        cause: { message: 'pre-output decode failure' }
      })
    } finally {
      logs.restore()
    }
  })

  test('row 3: reasoning closed before any text is still eligible for restart', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          // The inline dialect closes the reasoning block without emitting any
          // visible text, so the break lands after reasoning ended, before text.
          sdkStream(
            [{ assistantResponseEvent: { content: '<thinking>closed reasoning</thinking>' } }],
            new Error('reset after reasoning closed')
          ),
          sdkStream([
            { reasoningContentEvent: { text: 'restarted reasoning' } },
            { assistantResponseEvent: { content: 'final answer' } },
            { metadataEvent: { tokenUsage: { outputTokens: 2 } } }
          ])
        ],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'reasoning_restart'
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      const frames = sseFrames(await response.text())

      expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
      expect(
        frames.map((frame) => frame.choices?.[0]?.delta?.reasoning_content ?? '').join('')
      ).toBe('closed reasoningrestarted reasoning')
      expect(frames.map((frame) => frame.choices?.[0]?.delta?.content ?? '').join('')).toBe(
        'final answer'
      )
      expect(records(logs.warn, STREAM_FAILURE_LOG)[0]).toMatchObject({
        outcome: 'retrying',
        emittedReasoningChars: 'closed reasoning'.length,
        emittedVisibleChars: 0
      })
    } finally {
      logs.restore()
    }
  })

  test('row 7: a break after completion metadata stays ignored in recovery mode', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const terminated = new TypeError('terminated', {
        cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      })
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream(
            [
              { assistantResponseEvent: { content: 'complete response' } },
              { metadataEvent: { tokenUsage: { inputTokens: 4, outputTokens: 2 } } }
            ],
            terminated
          ),
          sdkStream([{ assistantResponseEvent: { content: 'must not be sent' } }])
        ],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'reasoning_restart'
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      const body = await response.text()

      expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
      expect(streamedText(body)).toBe('complete response')
      expect(body).toContain('"finish_reason":"stop"')
      expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(1)
      expect(
        records(logs.log, 'Kiro SDK event stream closed after completion metadata')[0]
      ).toMatchObject({ outcome: 'ignored_after_completion_metadata' })
      expect(
        [...logs.log.mock.calls, ...logs.warn.mock.calls, ...logs.error.mock.calls].some(
          (call) => call[0] === STREAM_FAILURE_LOG
        )
      ).toBe(false)
    } finally {
      logs.restore()
    }
  })

  test('row 8: caller abort while a recovery attempt is iterating issues no further send', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler } = buildHandler({
      selectResults: [acc, acc],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart'
    })
    installImmediateStreamBackoff(handler)
    const internals = handler as unknown as {
      makeSdkClient: () => { send: () => Promise<object> }
    }
    let sendCalls = 0
    const iterationStalled = Promise.withResolvers<void>()
    internals.makeSdkClient = () => ({
      send: async () => {
        sendCalls++
        if (sendCalls === 1) {
          return sdkStream(
            [{ reasoningContentEvent: { text: 'partial reasoning' } }],
            new Error('late reset')
          )
        }
        if (sendCalls === 2) {
          return {
            generateAssistantResponseResponse: (async function* () {
              yield { reasoningContentEvent: { text: 'recovered reasoning' } }
              iterationStalled.resolve()
              await new Promise<void>(() => {})
            })()
          }
        }
        return sdkStream([
          { assistantResponseEvent: { content: 'later request succeeds' } },
          { metadataEvent: { tokenUsage: { outputTokens: 1 } } }
        ])
      }
    })

    const controller = new AbortController()
    const response = await handler.handle(
      KIRO_URL,
      { body: JSON.stringify({}), signal: controller.signal },
      noToast
    )
    const reading = response.text()

    await iterationStalled.promise
    controller.abort(new DOMException('cancelled during recovery iteration', 'AbortError'))

    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(sendCalls).toBe(2)
    const next = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    expect(streamedText(await next.text())).toBe('later request succeeds')
    expect(sendCalls).toBe(3)
  })

  test('row 9: exhaustion sends exactly stream_max_attempts times and terminates once', async () => {
    const acc = makeAccount({ id: 'A' })
    const failure = new Error('persistent reasoning failure')
    const logs = captureLogger()
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream([{ reasoningContentEvent: { text: 'attempt one' } }], failure),
          sdkStream([{ reasoningContentEvent: { text: 'attempt two' } }], failure),
          sdkStream([{ reasoningContentEvent: { text: 'attempt three' } }], failure),
          sdkStream([{ assistantResponseEvent: { content: 'must not be sent' } }])
        ],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'reasoning_restart',
        streamMaxAttempts: 3
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

      await expect(response.text()).rejects.toMatchObject({
        name: 'UpstreamUnexpectedError',
        emittedOutput: true
      })
      expect(fakes.sdkSend).toHaveBeenCalledTimes(3)
      expect(records(logs.warn, STREAM_FAILURE_LOG)).toHaveLength(2)
      const terminal = records(logs.error, STREAM_FAILURE_LOG)
      expect(terminal).toHaveLength(1)
      expect(terminal[0]).toMatchObject({ outcome: 'terminated_after_output', emittedOutput: true })
    } finally {
      logs.restore()
    }
  })

  test('an empty upstream stream in recovery mode stays a success, not a truncation', async () => {
    const acc = makeAccount({ id: 'A', failCount: 2, unhealthyReason: 'transient' })
    const logs = captureLogger()
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [sdkStream([]), sdkStream([{ assistantResponseEvent: { content: 'unused' } }])],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'reasoning_restart'
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      const frames = sseFrames(await response.text())

      expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
      expect(frames.map((frame) => frame.choices?.[0]?.finish_reason)).toEqual(['stop'])
      expect(acc.failCount).toBe(0)
      expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(1)
      expect(
        [...logs.warn.mock.calls, ...logs.error.mock.calls].some(
          (call) => call[0] === STREAM_FAILURE_LOG
        )
      ).toBe(false)
      // The truncation predicate requires an unclosed tool intent, so a zero-event
      // stream is only ever marked, never turned into a recoverable failure.
      expect(records(logs.warn, STREAM_MISSING_COMPLETION_LOG)[0]).toMatchObject({
        outcome: 'clean_eof_without_completion_metadata',
        emittedReasoningChars: 0,
        emittedVisibleChars: 0
      })
    } finally {
      logs.restore()
    }
  })

  test('an unresolved dialect marker ends as a typed stream failure without a terminal chunk', async () => {
    const acc = makeAccount({ id: 'A', failCount: 3, unhealthyReason: 'transient' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream([
          { reasoningContentEvent: { text: 'signed-off reasoning' } },
          {
            assistantResponseEvent: {
              content: '<invoke name="read_file"><parameter name="path">/unfinished'
            }
          }
        ])
      ],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart',
      streamMaxAttempts: 1
    })

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const stream = response.body
    if (!stream) throw new Error('expected a streaming response body')
    const reader = stream.getReader()
    let delivered = ''
    const draining = (async () => {
      while (true) {
        const item = await reader.read()
        if (item.done) return
        delivered += new TextDecoder().decode(item.value)
      }
    })()

    await expect(draining).rejects.toMatchObject({
      name: 'UpstreamUnexpectedError',
      cause: {
        name: 'SdkEventStreamIterationError',
        cause: { name: 'SemanticStreamTruncationError' }
      }
    })
    expect(delivered).not.toContain('"finish_reason":"stop"')
    expect(delivered).not.toContain('"finish_reason":"tool_calls"')
    expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(0)
    expect(acc.failCount).toBe(3)
    expect(acc.unhealthyReason).toBe('transient')
  })

  for (const [region, content] of [
    [
      'fenced',
      'Example:\n```xml\n<invoke name="read"><parameter name="path">/tmp/x</parameter></invoke>\n```'
    ],
    ['inline', 'Use `<invoke name="read"><parameter name="path">/tmp/x</parameter></invoke>`.']
  ] as const) {
    test(`${region} code-only dialect markers stay byte-identical across recovery modes`, async () => {
      const bodies: string[] = []

      for (const mode of ['off', 'reasoning_restart', 'exact_replay'] as const) {
        const acc = makeAccount({ id: `A-${mode}` })
        const { handler, fakes } = buildHandler({
          selectResults: [acc],
          sdkResults: [sdkStream([{ assistantResponseEvent: { content } }])],
          streaming: true,
          useRealResponseHandler: true,
          streamRecoveryMode: mode
        })

        const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
        bodies.push((await response.text()).replace(/"created":\d+/g, '"created":0'))
        expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
        expect(fakes.usageTracker.syncUsage).toHaveBeenCalledTimes(1)
      }

      expect(bodies[1]).toBe(bodies[0])
      expect(bodies[2]).toBe(bodies[0])
    })
  }

  test('a recovered stream is one well-framed SSE sequence with a single terminal chunk', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream(
          [{ reasoningContentEvent: { text: 'first half ' } }],
          new Error('reset mid reasoning')
        ),
        sdkStream([
          { reasoningContentEvent: { text: 'second half' } },
          { assistantResponseEvent: { content: 'final answer' } },
          { metadataEvent: { tokenUsage: { outputTokens: 2, totalTokens: 2 } } }
        ])
      ],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'reasoning_restart'
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    const frames = sseFrames(await response.text())

    expect(frames.map((frame) => frame.choices?.[0]?.delta?.reasoning_content ?? '').join('')).toBe(
      'first half second half'
    )
    expect(frames.map((frame) => frame.choices?.[0]?.delta?.content ?? '').join('')).toBe(
      'final answer'
    )
    const terminalPositions = frames
      .map((frame, index) => ({ index, finish: frame.choices?.[0]?.finish_reason }))
      .filter((entry) => entry.finish !== null && entry.finish !== undefined)
    expect(terminalPositions).toEqual([{ index: frames.length - 1, finish: 'stop' }])
    const lastReasoning = frames.findLastIndex(
      (frame) => frame.choices?.[0]?.delta?.reasoning_content !== undefined
    )
    const firstContent = frames.findIndex(
      (frame) => frame.choices?.[0]?.delta?.content !== undefined
    )
    expect(lastReasoning).toBeLessThan(firstContent)
  })

  test('a live recovery writes no extra stream-start record', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream(
            [{ reasoningContentEvent: { text: 'partial reasoning' } }],
            new Error('late reset')
          ),
          sdkStream([
            { assistantResponseEvent: { content: 'recovered answer' } },
            { metadataEvent: { tokenUsage: { outputTokens: 1 } } }
          ])
        ],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'reasoning_restart'
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      await response.text()

      expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
      expect(records(logs.log, STREAM_REQUEST_STARTED_LOG)).toHaveLength(1)
    } finally {
      logs.restore()
    }
  })
})

describe('RequestHandler.handle — §9 Tier B exact-replay fault-injection matrix', () => {
  // The transformer withholds the trailing `<thinking>`-tag-sized window of a
  // content event until more text arrives, so a bare content event that breaks
  // mid-stream delivers only its leading characters. A native reasoning event
  // ahead of the text closes that window, which makes the delivered prefix
  // exactly the injected strings and keeps these rows about routing, not about
  // buffer arithmetic.
  const THOUGHT = 'thought'
  const DELIVERED = 'hello world'
  const SHADOW_LEAK = 'MUST-NOT-LEAK'
  const DIVERGENT = `hello wurld ${SHADOW_LEAK}`
  const MATCHED_UNTIL = 'hello w'.length

  function reasoningThenText(content: string, ...trailing: unknown[]): unknown[] {
    return [
      { reasoningContentEvent: { text: THOUGHT } },
      { assistantResponseEvent: { content } },
      ...trailing
    ]
  }

  function expectNoShadow(body: string): void {
    expect(body).not.toContain(SHADOW_LEAK)
    expect(body).not.toContain('wurld')
  }

  test('row text mid-break: a divergent replay is attempted and leaks no byte downstream', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream(reasoningThenText(DELIVERED), new Error('first reset')),
          sdkStream(reasoningThenText(DIVERGENT)),
          sdkStream(
            reasoningThenText(`${DELIVERED}!`, {
              metadataEvent: { tokenUsage: { outputTokens: 2 } }
            })
          )
        ],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'exact_replay'
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      const body = await response.text()
      const frames = sseFrames(body)

      expect(fakes.sdkSend).toHaveBeenCalledTimes(3)
      expect(joinedDelta(frames, 'reasoning_content')).toBe(THOUGHT)
      expect(joinedDelta(frames, 'content')).toBe(`${DELIVERED}!`)
      expectNoShadow(body)
      expect(terminalFrames(frames)).toHaveLength(1)
      expect(
        records(logs.log, REPLAY_TELEMETRY_LOG).map((entry) => [
          entry['replayOutcome'],
          entry['divergenceChannel'],
          entry['matchedReasoningChars'],
          entry['matchedVisibleChars']
        ])
      ).toEqual([
        ['diverged', 'text', THOUGHT.length, MATCHED_UNTIL],
        ['caught_up', 'none', THOUGHT.length, DELIVERED.length]
      ])
    } finally {
      logs.restore()
    }
  })

  test('row budget exhausted: the terminal error keeps its shape and the shadow stays withheld', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream(reasoningThenText(DELIVERED), new Error('first reset')),
          sdkStream(reasoningThenText(DIVERGENT))
        ],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'exact_replay',
        streamMaxAttempts: 2
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      const stream = response.body
      if (!stream) throw new Error('expected a streaming response body')
      const reader = stream.getReader()
      let delivered = ''
      const draining = (async () => {
        while (true) {
          const item = await reader.read()
          if (item.done) return
          delivered += new TextDecoder().decode(item.value)
        }
      })()

      await expect(draining).rejects.toMatchObject({
        name: 'UpstreamUnexpectedError',
        emittedOutput: true
      })
      expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
      const frames = sseFrames(delivered)
      expect(joinedDelta(frames, 'content')).toBe(DELIVERED)
      expect(joinedDelta(frames, 'reasoning_content')).toBe(THOUGHT)
      expectNoShadow(delivered)
      expect(terminalFrames(frames)).toHaveLength(0)
      expect(records(logs.log, REPLAY_TELEMETRY_LOG)).toEqual([
        expect.objectContaining({
          divergenceChannel: 'text',
          replayOutcome: 'diverged',
          matchedVisibleChars: MATCHED_UNTIL
        })
      ])
      expect(records(logs.error, STREAM_FAILURE_LOG)[0]).toMatchObject({
        outcome: 'terminated_after_output',
        emittedOutput: true
      })
    } finally {
      logs.restore()
    }
  })

  test('row completed tool call: a mid-stream break still delivers no tool prefix to match', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream(
            [
              { reasoningContentEvent: { text: THOUGHT } },
              {
                toolUseEvent: {
                  toolUseId: 'tool-1',
                  name: 'read_file',
                  input: '{"path":"/a"}',
                  stop: true
                }
              }
            ],
            new Error('reset after a completed tool call')
          ),
          sdkStream([{ assistantResponseEvent: { content: 'must not be sent' } }])
        ],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'exact_replay'
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

      // The transformer accumulates tool calls and emits them only after the
      // event loop drains, so a break can never leave a delivered tool prefix:
      // `sawToolIntent` is set while `emittedToolCount` stays 0, which routes to
      // 'none'. The matcher's tool channel is therefore exercised at the
      // coordinator level, not through this path.
      await expect(response.text()).rejects.toMatchObject({
        name: 'UpstreamUnexpectedError',
        emittedOutput: true
      })
      expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
      expect(records(logs.error, STREAM_FAILURE_LOG)[0]).toMatchObject({
        outcome: 'terminated_after_output',
        emittedToolCount: 0,
        sawToolIntent: true
      })
      expect(records(logs.log, REPLAY_TELEMETRY_LOG)).toEqual([])
    } finally {
      logs.restore()
    }
  })

  test('row raw tool intent: an intent-only break stays terminal instead of replaying', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream(
            [
              { reasoningContentEvent: { text: 'reasoning before tool intent' } },
              { toolUseEvent: { name: 'read_file', toolUseId: 'tool-1', input: '{"path":"/a' } }
            ],
            new Error('tool stream failed')
          ),
          sdkStream([{ assistantResponseEvent: { content: 'must not be sent' } }])
        ],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'exact_replay'
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

      // `sawToolIntent` disqualifies Tier A while zero visible text and zero
      // emitted tools also disqualify Tier B, so `decideRecoveryTier` returns
      // 'none'. This is deliberately conservative: an unfinished tool intent
      // leaves nothing for a replay to match against. Pinned so a routing
      // change cannot pass silently; loosening it is a Phase 3 question.
      await expect(response.text()).rejects.toMatchObject({
        name: 'UpstreamUnexpectedError',
        emittedOutput: true
      })
      expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
      expect(records(logs.log, REPLAY_TELEMETRY_LOG)).toEqual([])
    } finally {
      logs.restore()
    }
  })

  test('row clean EOF: healthy reasoning and text without metadata skips exact replay', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream(reasoningThenText(DELIVERED)),
          sdkStream(reasoningThenText('must not be sent'))
        ],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'exact_replay'
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      const frames = sseFrames(await response.text())

      expect(fakes.sdkSend).toHaveBeenCalledTimes(1)
      expect(joinedDelta(frames, 'content')).toBe(DELIVERED)
      expect(joinedDelta(frames, 'reasoning_content')).toBe(THOUGHT)
      expect(terminalFrames(frames)).toHaveLength(1)
      expect(records(logs.log, REPLAY_TELEMETRY_LOG)).toEqual([])
    } finally {
      logs.restore()
    }
  })

  test('row mode ordering: a reasoning-only break under exact_replay never builds a matcher', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream(
            [{ reasoningContentEvent: { text: 'partial reasoning' } }],
            new Error('reasoning reset')
          ),
          sdkStream([
            { reasoningContentEvent: { text: 'restarted reasoning' } },
            { assistantResponseEvent: { content: 'final answer' } },
            { metadataEvent: { tokenUsage: { outputTokens: 2 } } }
          ])
        ],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'exact_replay'
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      const frames = sseFrames(await response.text())

      expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
      expect(joinedDelta(frames, 'reasoning_content')).toBe('partial reasoningrestarted reasoning')
      expect(joinedDelta(frames, 'content')).toBe('final answer')
      expect(records(logs.log, REPLAY_TELEMETRY_LOG)).toEqual([])
    } finally {
      logs.restore()
    }
  })

  test('exact replay honors stream_max_attempts and logs one telemetry record per replay', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler, fakes } = buildHandler({
        selectResults: [acc],
        sdkResults: [
          sdkStream(reasoningThenText(DELIVERED), new Error('first reset')),
          sdkStream(reasoningThenText(DIVERGENT)),
          sdkStream(reasoningThenText(DIVERGENT)),
          sdkStream(reasoningThenText(`${DELIVERED}!`))
        ],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'exact_replay',
        streamMaxAttempts: 3
      })
      installImmediateStreamBackoff(handler)

      const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

      await expect(response.text()).rejects.toMatchObject({
        name: 'UpstreamUnexpectedError',
        emittedOutput: true
      })
      expect(fakes.sdkSend).toHaveBeenCalledTimes(3)
      const telemetry = records(logs.log, REPLAY_TELEMETRY_LOG)
      expect(telemetry.map((entry) => entry['attempts'])).toEqual([2, 3])
      expect(telemetry.map((entry) => entry['quotaNote'])).toEqual([
        'each exact replay attempt consumes one real SDK send',
        'each exact replay attempt consumes one real SDK send'
      ])
    } finally {
      logs.restore()
    }
  })

  test('exact replay stops at the RetryStrategy iteration budget before stream_max_attempts', async () => {
    const acc = makeAccount({ id: 'A' })
    const { handler, fakes } = buildHandler({
      selectResults: [acc],
      sdkResults: [
        sdkStream(reasoningThenText(DELIVERED), new Error('first reset')),
        sdkStream(reasoningThenText(DIVERGENT)),
        sdkStream(reasoningThenText(`${DELIVERED}!`))
      ],
      streaming: true,
      useRealResponseHandler: true,
      streamRecoveryMode: 'exact_replay',
      streamMaxAttempts: 5,
      maxRequestIterations: 2
    })
    installImmediateStreamBackoff(handler)

    const response = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    await expect(response.text()).rejects.toMatchObject({
      name: 'UpstreamUnexpectedError',
      emittedOutput: true
    })
    expect(fakes.sdkSend).toHaveBeenCalledTimes(2)
  })

  test('caller abort while a shadow replay is withheld releases the queue for the next request', async () => {
    const acc = makeAccount({ id: 'A' })
    const logs = captureLogger()
    try {
      const { handler } = buildHandler({
        selectResults: [acc, acc],
        streaming: true,
        useRealResponseHandler: true,
        streamRecoveryMode: 'exact_replay'
      })
      installImmediateStreamBackoff(handler)
      const internals = handler as unknown as {
        makeSdkClient: () => { send: () => Promise<object> }
      }
      let sendCalls = 0
      const shadowWithheld = Promise.withResolvers<void>()
      internals.makeSdkClient = () => ({
        send: async () => {
          sendCalls++
          if (sendCalls === 1) {
            return sdkStream(reasoningThenText(DELIVERED), new Error('late reset'))
          }
          if (sendCalls === 2) {
            return {
              generateAssistantResponseResponse: (async function* () {
                yield { reasoningContentEvent: { text: THOUGHT } }
                shadowWithheld.resolve()
                await new Promise<void>(() => {})
              })()
            }
          }
          return sdkStream([
            { assistantResponseEvent: { content: 'later request succeeds' } },
            { metadataEvent: { tokenUsage: { outputTokens: 1 } } }
          ])
        }
      })

      const controller = new AbortController()
      const response = await handler.handle(
        KIRO_URL,
        { body: JSON.stringify({}), signal: controller.signal },
        noToast
      )
      const reading = response.text()

      await shadowWithheld.promise
      controller.abort(new DOMException('cancelled while withholding', 'AbortError'))

      await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
      expect(sendCalls).toBe(2)
      expect(records(logs.log, REPLAY_TELEMETRY_LOG)).toEqual([])
      const next = await handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
      expect(streamedText(await next.text())).toBe('later request succeeds')
      expect(sendCalls).toBe(3)
    } finally {
      logs.restore()
    }
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
