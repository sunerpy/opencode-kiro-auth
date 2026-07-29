import { describe, expect, mock, spyOn, test } from 'bun:test'
import {
  ErrorHandler,
  THINKING_SIGNATURE_INVALID_REASON,
  type RequestContext
} from '../core/request/error-handler.js'
import { RequestHandler } from '../core/request/request-handler.js'
import * as requestModule from '../plugin/request.js'
import { stripReasoningContent, transformToSdkRequest } from '../plugin/request.js'
import type {
  CodeWhispererRequest,
  KiroAuthDetails,
  ManagedAccount,
  SdkPreparedRequest
} from '../plugin/types.js'

// Wave 3 of the reasoning-signature roundtrip plan: the recovery plumbing for a
// pre-stream HTTP 400 whose modeled `reason` is THINKING_SIGNATURE_INVALID.
// Nothing in the plugin emits a replayed signature yet (that is Wave 5), so every
// case here drives a SYNTHETIC 400 — which is the point: the safety net must be
// provably correct before the feature that can trigger it exists.

type Variant = 'info' | 'warning' | 'success' | 'error'
type ToastFn = (message: string, variant: Variant) => void

const noToast: ToastFn = () => {}
const CONFIG = { rate_limit_max_retries: 3, rate_limit_retry_delay_ms: 5000 }

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
    markRateLimited: mock(() => {}),
    toAuthDetails: mock((acc: ManagedAccount) => ({
      access: acc.accessToken,
      refresh: acc.refreshToken,
      expires: acc.expiresAt,
      authMethod: 'idc',
      region: acc.region,
      email: acc.email
    }))
  } as any
}

function makeRepository() {
  return { batchSave: mock(async () => {}), save: mock(async () => {}) } as any
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('ErrorHandler 400 — THINKING_SIGNATURE_INVALID recovery', () => {
  test('retries once, pins the account, and sets both recovery flags', async () => {
    const accountManager = makeAccountManager(3)
    const repository = makeRepository()
    const handler = new ErrorHandler(CONFIG, accountManager, repository)
    const account = makeAccount()
    const toast = mock(noToast)

    const res = await handler.handle(
      new Error('Invalid signature in thinking block'),
      jsonResponse(400, {
        message: 'Invalid signature in thinking block',
        __type: 'ValidationException',
        reason: THINKING_SIGNATURE_INVALID_REASON
      }),
      account,
      { retry: 0 },
      toast
    )

    expect(res.shouldRetry).toBe(true)
    expect(res.pinAccount).toBe(true)
    expect(res.switchAccount).toBeUndefined()
    expect(res.newContext?.signatureRecoveryAttempted).toBe(true)
    expect(res.newContext?.disableReasoningReplay).toBe(true)
    // A request-level rejection is not evidence the account is bad.
    expect(account.failCount).toBe(0)
    expect(account.isHealthy).toBe(true)
    expect(account.unhealthyReason).toBeUndefined()
    expect(accountManager.markUnhealthy).toHaveBeenCalledTimes(0)
    expect(accountManager.markRateLimited).toHaveBeenCalledTimes(0)
    expect(repository.batchSave).toHaveBeenCalledTimes(0)
    expect(toast).toHaveBeenCalledWith(
      '400: Replayed reasoning signature rejected. Retrying without it...',
      'warning'
    )
  })

  test('does not advance the generic retry counter (recovery has its own bound)', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const res = await handler.handle(
      new Error('bad signature'),
      jsonResponse(400, { message: 'bad signature', reason: THINKING_SIGNATURE_INVALID_REASON }),
      makeAccount(),
      { retry: 2 },
      noToast
    )
    expect(res.shouldRetry).toBe(true)
    expect(res.newContext?.retry).toBe(2)
  })

  test('preserves forcedRefreshAccountIds across the recovery retry', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(1), makeRepository())
    const forced = new Set(['acc-9'])
    const res = await handler.handle(
      new Error('bad signature'),
      jsonResponse(400, { message: 'bad signature', reason: THINKING_SIGNATURE_INVALID_REASON }),
      makeAccount(),
      { retry: 0, forcedRefreshAccountIds: forced },
      noToast
    )
    expect(res.newContext?.forcedRefreshAccountIds).toBe(forced)
  })

  test('a second rejection is terminal — bounded by signatureRecoveryAttempted', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(3), makeRepository())
    const toast = mock(noToast)
    const context: RequestContext = {
      retry: 0,
      signatureRecoveryAttempted: true,
      disableReasoningReplay: true
    }

    const res = await handler.handle(
      new Error('Invalid signature in thinking block'),
      jsonResponse(400, {
        message: 'Invalid signature in thinking block',
        reason: THINKING_SIGNATURE_INVALID_REASON
      }),
      makeAccount(),
      context,
      toast
    )

    expect(res.shouldRetry).toBe(false)
    expect(res.pinAccount).toBeUndefined()
    expect(toast).toHaveBeenCalledWith('400: Invalid signature in thinking block', 'error')
  })

  test('does NOT shadow a size-overflow 400 even when the reason is also present', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(3), makeRepository())
    const overflowReasonRes = await handler.handle(
      new Error('Input is too long.'),
      jsonResponse(400, {
        message: 'Input is too long.',
        reason: THINKING_SIGNATURE_INVALID_REASON
      }),
      makeAccount(),
      { retry: 0 },
      noToast
    )
    // Terminal, so RequestHandler's 400 -> 413 remap still runs and OpenCode compacts.
    expect(overflowReasonRes.shouldRetry).toBe(false)
    expect(overflowReasonRes.pinAccount).toBeUndefined()

    const thresholdRes = await handler.handle(
      new Error('too big'),
      jsonResponse(400, {
        message: 'too big',
        reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD'
      }),
      makeAccount(),
      { retry: 0 },
      noToast
    )
    expect(thresholdRes.shouldRetry).toBe(false)
  })

  test('an ordinary 400 with an unrelated reason still terminates', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(3), makeRepository())
    const toast = mock(noToast)
    const res = await handler.handle(
      new Error('Invalid model'),
      jsonResponse(400, { message: 'Invalid model', reason: 'INVALID_MODEL_ID' }),
      makeAccount(),
      { retry: 0 },
      toast
    )
    expect(res.shouldRetry).toBe(false)
    expect(toast).toHaveBeenCalledWith('400: Invalid model', 'error')
  })

  test('a 400 with no reason at all still terminates with the existing message shape', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(3), makeRepository())
    const toast = mock(noToast)
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

  test('an unparseable 400 body terminates without throwing', async () => {
    const handler = new ErrorHandler(CONFIG, makeAccountManager(3), makeRepository())
    const toast = mock(noToast)
    const res = await handler.handle(
      new Error('boom'),
      new Response('<html>gateway</html>', { status: 400 }),
      makeAccount(),
      { retry: 0 },
      toast
    )
    expect(res.shouldRetry).toBe(false)
    expect(toast).toHaveBeenCalledWith('400: unknown', 'error')
  })
})

const fakeAuth: KiroAuthDetails = {
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 3600000,
  authMethod: 'idc',
  region: 'us-east-1',
  profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEFGHIJK'
}

function signedConversationState(): CodeWhispererRequest['conversationState'] {
  return {
    chatTriggerType: 'MANUAL',
    conversationId: 'conv-1',
    history: [
      { userInputMessage: { content: 'hi', modelId: 'claude-opus-5', origin: 'AI_EDITOR' } },
      {
        assistantResponseMessage: {
          content: 'answer one',
          reasoningContent: { reasoningText: { text: 'thought one', signature: 'sig-one' } }
        }
      },
      {
        assistantResponseMessage: {
          content: 'answer two',
          toolUses: [{ input: {}, name: 'bash', toolUseId: 'tu-1' }],
          reasoningContent: { reasoningText: { text: 'thought two', signature: 'sig-two' } }
        }
      }
    ],
    currentMessage: {
      assistantResponseMessage: {
        content: 'current',
        reasoningContent: { reasoningText: { text: 'thought now', signature: 'sig-now' } }
      }
    }
  }
}

describe('stripReasoningContent', () => {
  test('removes every reasoningContent block from history and the current message', () => {
    const state = signedConversationState()
    stripReasoningContent(state)

    const serialized = JSON.stringify(state)
    expect(serialized).not.toContain('reasoningContent')
    expect(serialized).not.toContain('sig-one')
    expect(serialized).not.toContain('sig-two')
    expect(serialized).not.toContain('sig-now')
    // Everything else survives untouched.
    expect(state.history?.[1]?.assistantResponseMessage?.content).toBe('answer one')
    expect(state.history?.[2]?.assistantResponseMessage?.toolUses?.[0]?.toolUseId).toBe('tu-1')
    expect(state.currentMessage.assistantResponseMessage?.content).toBe('current')
    expect(state.history).toHaveLength(3)
  })

  test('is a no-op on a state that carries no reasoning', () => {
    const state: CodeWhispererRequest['conversationState'] = {
      chatTriggerType: 'MANUAL',
      conversationId: 'conv-2',
      currentMessage: {
        userInputMessage: { content: 'hello', modelId: 'claude-opus-5', origin: 'AI_EDITOR' }
      }
    }
    const before = JSON.stringify(state)
    stripReasoningContent(state)
    expect(JSON.stringify(state)).toBe(before)
  })
})

describe('transformToSdkRequest — disableReasoningReplay', () => {
  const body = {
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answered', reasoning_content: 'prior thinking' },
      { role: 'user', content: 'second' }
    ]
  }

  test('produces a request with no reasoningContent when the flag is set', () => {
    const req = transformToSdkRequest(body, 'claude-opus-5', fakeAuth, false, 20000, undefined, {
      disableReasoningReplay: true
    })
    expect(JSON.stringify(req.conversationState)).not.toContain('reasoningContent')
  })

  test('effort resolution is unaffected by the new option shape', () => {
    const withFlag = transformToSdkRequest(
      body,
      'claude-opus-5-xhigh',
      fakeAuth,
      false,
      20000,
      undefined,
      { disableReasoningReplay: true }
    )
    const withoutFlag = transformToSdkRequest(body, 'claude-opus-5-xhigh', fakeAuth)
    expect(withFlag.effort).toBe(withoutFlag.effort)
    expect(withFlag.effectiveModel).toBe(withoutFlag.effectiveModel)
  })
})

// End-to-end through the real RequestHandler retry loop with the REAL ErrorHandler,
// so the whole chain is exercised: synthetic SDK error -> synthetic error body
// carrying `reason` -> 400 branch -> pinned retry -> prepareSdkRequest receiving
// disableReasoningReplay.

const KIRO_URL = 'https://q.us-east-1.amazonaws.com/generateAssistantResponse'

function cannedPrep(): SdkPreparedRequest {
  return {
    conversationState: { chatTriggerType: 'MANUAL', conversationId: 'c1' } as any,
    profileArn: 'arn:aws:test',
    streaming: false,
    effectiveModel: 'claude-opus-5',
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
  sdk_response_timeout_enabled: false,
  sdk_response_timeout_ms: 300000,
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

function signatureInvalidError(message = 'Invalid signature in thinking block'): Error {
  const error = new Error(message) as Error & {
    name: string
    reason: string
    $metadata: { httpStatusCode: number }
  }
  error.name = 'ValidationException'
  error.reason = THINKING_SIGNATURE_INVALID_REASON
  error.$metadata = { httpStatusCode: 400 }
  return error
}

function buildLiveHandler(opts: { accounts: ManagedAccount[]; sdkResults: Array<any | Error> }): {
  handler: RequestHandler
  selectHealthyAccount: ReturnType<typeof mock>
  sdkSend: ReturnType<typeof mock>
  prepareCalls: boolean[]
  usedAccountIds: string[]
  accountManager: any
  repository: any
} {
  const sdkQueue = [...opts.sdkResults]
  const prepareCalls: boolean[] = []
  const usedAccountIds: string[] = []
  const accountManager = makeAccountManager(opts.accounts.length)
  accountManager.getAccounts = mock(() => opts.accounts)
  const repository = makeRepository()

  const selectHealthyAccount = mock(async () => opts.accounts[0] ?? null)
  const sdkSend = mock(async () => {
    const next = sdkQueue.shift()
    if (next instanceof Error) throw next
    return next ?? {}
  })

  const handler = new RequestHandler(accountManager, { ...baseConfig }, repository)
  const internals = handler as any
  internals.accountSelector = {
    selectHealthyAccount,
    selectAlternativeAccount: mock(async () => null)
  }
  internals.tokenRefresher = {
    refreshIfNeeded: mock(async (acc: ManagedAccount) => ({ shouldContinue: false, account: acc })),
    forceRefresh: mock(async () => ({ ok: true, dead: false }))
  }
  internals.responseHandler = {
    handleSdkSuccess: mock(async (_r: unknown, _m: string, _c: string, _s: boolean, lc?: any) => {
      await lc?.onComplete?.()
      return new Response('ok')
    })
  }
  internals.usageTracker = { syncUsage: mock(async () => {}) }
  internals.makeSdkClient = () => ({ send: sdkSend })
  internals.prepareSdkRequest = (
    _body: unknown,
    _model: string,
    _auth: unknown,
    _think: boolean,
    _budget: number,
    _toast: unknown,
    disableReasoningReplay = false
  ) => {
    prepareCalls.push(disableReasoningReplay)
    return cannedPrep()
  }
  const originalSuccess = internals.handleSuccessfulRequest.bind(handler)
  internals.handleSuccessfulRequest = (acc: ManagedAccount) => {
    usedAccountIds.push(acc.id)
    originalSuccess(acc)
  }

  return {
    handler,
    selectHealthyAccount,
    sdkSend,
    prepareCalls,
    usedAccountIds,
    accountManager,
    repository
  }
}

describe('RequestHandler — THINKING_SIGNATURE_INVALID end to end', () => {
  test('the synthetic error body carries `reason` so the handler can classify it', async () => {
    const acc = makeAccount({ id: 'A' })
    const live = buildLiveHandler({
      accounts: [acc],
      sdkResults: [signatureInvalidError(), { generateAssistantResponseResponse: {} }]
    })
    const errorHandler = (live.handler as any).errorHandler
    const handleSpy = mock(errorHandler.handle.bind(errorHandler))
    ;(live.handler as any).errorHandler = {
      handle: handleSpy,
      handleNetworkError: errorHandler.handleNetworkError.bind(errorHandler)
    }

    await live.handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    const passedResponse = handleSpy.mock.calls[0]![1] as Response
    const parsed = (await passedResponse.json()) as Record<string, unknown>
    expect(parsed.reason).toBe(THINKING_SIGNATURE_INVALID_REASON)
    expect(parsed.message).toBe('Invalid signature in thinking block')
    expect(parsed.__type).toBe('ValidationException')
  })

  test('an error with no reason field produces a body without a reason key', async () => {
    const acc = makeAccount({ id: 'A' })
    const plain: any = new Error('Improperly formed request.')
    plain.name = 'ValidationException'
    plain.$metadata = { httpStatusCode: 400 }
    const live = buildLiveHandler({ accounts: [acc], sdkResults: [plain] })

    const res = await live.handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)
    expect(res.status).toBe(400)
    const parsed = (await res.json()) as Record<string, unknown>
    expect('reason' in parsed).toBe(false)
    expect(parsed.message).toBe('Improperly formed request.')
  })

  test('retries exactly once on the same account with reasoning replay disabled', async () => {
    const acc = makeAccount({ id: 'A' })
    const other = makeAccount({ id: 'B', email: 'b@example.com' })
    const live = buildLiveHandler({
      accounts: [acc, other],
      sdkResults: [signatureInvalidError(), { generateAssistantResponseResponse: {} }]
    })

    const res = await live.handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    expect(res.status).toBe(200)
    expect(live.sdkSend).toHaveBeenCalledTimes(2)
    // First attempt replays reasoning; the recovery attempt must not.
    expect(live.prepareCalls).toEqual([false, true])
    // Account was pinned: selection ran only for the first attempt.
    expect(live.selectHealthyAccount).toHaveBeenCalledTimes(1)
    expect(live.usedAccountIds).toEqual(['A'])
    // No health state was touched on either account.
    expect(live.accountManager.markUnhealthy).toHaveBeenCalledTimes(0)
    expect(live.accountManager.markRateLimited).toHaveBeenCalledTimes(0)
    expect(acc.failCount).toBe(0)
    expect(acc.isHealthy).toBe(true)
    expect(other.failCount).toBe(0)
    expect(other.isHealthy).toBe(true)
  })

  test('a repeated rejection stays bounded and surfaces a terminal 400', async () => {
    const acc = makeAccount({ id: 'A' })
    const live = buildLiveHandler({
      accounts: [acc],
      sdkResults: [signatureInvalidError(), signatureInvalidError('rejected again')]
    })

    const res = await live.handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    expect(res.status).toBe(400)
    const parsed = (await res.json()) as Record<string, unknown>
    expect(parsed.message).toBe('rejected again')
    expect(parsed.reason).toBe(THINKING_SIGNATURE_INVALID_REASON)
    // Exactly one recovery attempt — two sends total, never a loop.
    expect(live.sdkSend).toHaveBeenCalledTimes(2)
    expect(live.prepareCalls).toEqual([false, true])
    expect(live.selectHealthyAccount).toHaveBeenCalledTimes(1)
    expect(acc.isHealthy).toBe(true)
    expect(acc.failCount).toBe(0)
  })

  test('a size-overflow 400 still remaps to 413 with the recovery branch present', async () => {
    const acc = makeAccount({ id: 'A' })
    const overflow: any = new Error('Input is too long.')
    overflow.name = 'ValidationException'
    overflow.reason = 'CONTENT_LENGTH_EXCEEDS_THRESHOLD'
    overflow.$metadata = { httpStatusCode: 400 }
    const live = buildLiveHandler({ accounts: [acc], sdkResults: [overflow] })

    const res = await live.handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    expect(res.status).toBe(413)
    const parsed = (await res.json()) as Record<string, unknown>
    expect(parsed.message).toBe('Input is too long.')
    expect(parsed.reason).toBe('CONTENT_LENGTH_EXCEEDS_THRESHOLD')
    expect(live.sdkSend).toHaveBeenCalledTimes(1)
    expect(live.prepareCalls).toEqual([false])
  })

  test('an overflow body that also claims a signature reason still remaps to 413', async () => {
    const acc = makeAccount({ id: 'A' })
    const live = buildLiveHandler({
      accounts: [acc],
      sdkResults: [signatureInvalidError('Input is too long.')]
    })

    const res = await live.handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    expect(res.status).toBe(413)
    expect(live.sdkSend).toHaveBeenCalledTimes(1)
    expect(live.prepareCalls).toEqual([false])
  })

  test('the flag reaches the real transformToSdkRequest through the untouched seam', async () => {
    const acc = makeAccount({ id: 'A' })
    const live = buildLiveHandler({
      accounts: [acc],
      sdkResults: [signatureInvalidError(), { generateAssistantResponseResponse: {} }]
    })
    // Restore the real prepareSdkRequest and observe the module boundary instead,
    // so the assertion covers the actual call into the request builder.
    delete (live.handler as any).prepareSdkRequest
    const transformSpy = spyOn(requestModule, 'transformToSdkRequest').mockImplementation(
      () => cannedPrep() as any
    )

    try {
      await live.handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

      expect(transformSpy).toHaveBeenCalledTimes(2)
      const firstOptions = transformSpy.mock.calls[0]![6] as Record<string, unknown>
      const retryOptions = transformSpy.mock.calls[1]![6] as Record<string, unknown>
      expect(firstOptions.disableReasoningReplay).toBe(false)
      expect(retryOptions.disableReasoningReplay).toBe(true)
    } finally {
      transformSpy.mockRestore()
    }
  })

  test('an ordinary 400 terminates on the first attempt as before', async () => {
    const acc = makeAccount({ id: 'A' })
    const invalidModel: any = new Error('Invalid model. Please select a different model.')
    invalidModel.name = 'ValidationException'
    invalidModel.reason = 'INVALID_MODEL_ID'
    invalidModel.$metadata = { httpStatusCode: 400 }
    const live = buildLiveHandler({ accounts: [acc], sdkResults: [invalidModel] })

    const res = await live.handler.handle(KIRO_URL, { body: JSON.stringify({}) }, noToast)

    expect(res.status).toBe(400)
    expect(live.sdkSend).toHaveBeenCalledTimes(1)
    expect(live.prepareCalls).toEqual([false])
  })
})
