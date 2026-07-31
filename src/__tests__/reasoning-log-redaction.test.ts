import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequestHandler } from '../core/request/request-handler.js'
import { buildSdkRequestLogPayload } from '../core/request/sdk-log-payload.js'
import { UpstreamUnexpectedError } from '../core/request/stream-error.js'
import { describeReasoningContentForLog, sha256Prefix } from '../plugin/log-redaction.js'
import {
  configureLogging,
  getTimestamp,
  logApiError,
  logApiRequest,
  error as logError,
  resetLoggingForTests
} from '../plugin/logger.js'
import { reasoningCorrelationCache } from '../plugin/reasoning/correlation-cache.js'
import { transformToSdkRequest } from '../plugin/request.js'
import type {
  CodeWhispererMessage,
  KiroAuthDetails,
  ManagedAccount,
  SdkPreparedRequest
} from '../plugin/types.js'

// Wave 6 (§6.8). These tests FAIL if a raw signature or a raw redacted byte payload
// ever reaches a log file, a thrown error, or an error response body. Measured at
// `18c27ba`: the then-current call sites happened not to leak, but handing the full
// `conversationState` to either log sink wrote the raw 324-char signature verbatim.
// The signature length here (324) sits inside the 304-560 range observed from the
// real API, so a substring assertion cannot pass by accident on a short stub.

const MODEL = 'claude-opus-5'
const SIG = `sig-${'A'.repeat(320)}`
const REASONING = 'private chain of thought that the signature covers'
const STREAMED_REPLY = 'the streamed reply body that must never reach a log'
const REDACTED_BYTES = new Uint8Array(
  Array.from({ length: 96 }, (_value, index) => (index * 7 + 13) % 256)
)
const REDACTED_BASE64 = Buffer.from(REDACTED_BYTES).toString('base64')

const auth: KiroAuthDetails = {
  refresh: 'refresh-token',
  access: 'access-token',
  expires: Date.now() + 3_600_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

let logHome: string
const savedXdg = process.env.XDG_CONFIG_HOME

function logDir(): string {
  return join(logHome, 'opencode', 'kiro-auth-plugin', 'logs')
}

function allLogText(): string {
  if (!existsSync(logDir())) return ''
  return readdirSync(logDir())
    .map((file) => readFileSync(join(logDir(), file), 'utf8'))
    .join('\n')
}

function apiRecords(): Array<Record<string, unknown>> {
  if (!existsSync(logDir())) return []
  return readdirSync(logDir())
    .filter((file) => file.endsWith('.ndjson'))
    .flatMap((file) =>
      readFileSync(join(logDir(), file), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    )
}

function expectNoLeak(text: string): void {
  expect(text).not.toContain(SIG)
  expect(text).not.toContain(SIG.slice(0, 64))
  expect(text).not.toContain(REDACTED_BASE64)
  expect(text).not.toContain(REDACTED_BASE64.slice(0, 32))
}

/** A prepared request whose history carries a Wave-5 replayed signed envelope. */
function signedPrep(): SdkPreparedRequest {
  reasoningCorrelationCache.clearAllForTests()
  reasoningCorrelationCache.publish({
    reasoningText: REASONING,
    visibleText: 'visible answer',
    toolUses: [],
    effectiveModel: MODEL,
    envelope: { kind: 'reasoningText', text: REASONING, signature: SIG },
    loopId: 'loop:redaction',
    accountId: 'acct-A',
    attemptId: 'attempt:redaction'
  })
  const prep = transformToSdkRequest(
    {
      messages: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'visible answer', reasoning_content: REASONING }
      ]
    },
    MODEL,
    auth
  )
  const signed = (prep.conversationState.history ?? []).filter(
    (entry) => entry.assistantResponseMessage?.reasoningContent
  )
  if (signed.length === 0) throw new Error('fixture produced no signed history turn')
  return prep
}

function redactedBytesHistory(): CodeWhispererMessage[] {
  return [
    {
      assistantResponseMessage: {
        content: 'answer',
        reasoningContent: { redactedContent: REDACTED_BYTES }
      }
    }
  ]
}

beforeEach(() => {
  resetLoggingForTests()
  logHome = mkdtempSync(join(tmpdir(), 'kiro-redaction-'))
  process.env.XDG_CONFIG_HOME = logHome
  configureLogging({
    log_retention_days: 7,
    log_max_total_size_mb: 512,
    log_compress_after_days: 1,
    log_segment_size_mb: 16
  })
  mkdirSync(logDir(), { recursive: true })
})

afterEach(() => {
  resetLoggingForTests()
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdg
  rmSync(logHome, { recursive: true, force: true })
  reasoningCorrelationCache.clearAllForTests()
})

describe('§6.8 redaction — API log sink', () => {
  test('a full signed conversationState reaches the API log with no raw signature', () => {
    const prep = signedPrep()
    logApiRequest({ body: { conversationState: prep.conversationState } }, getTimestamp())

    const text = allLogText()
    expect(text.length).toBeGreaterThan(0)
    expectNoLeak(text)
    expect(text).toContain(sha256Prefix(SIG))
    expect(text).toContain('"present":true')
    expect(text).toContain(`"length":${SIG.length}`)
  })

  test('the recorded envelope is exactly the {present, length, sha256Prefix} shape', () => {
    const prep = signedPrep()
    logApiRequest({ body: { conversationState: prep.conversationState } }, getTimestamp())

    const serialized = JSON.stringify(apiRecords())
    expect(serialized).toContain(
      JSON.stringify({
        present: true,
        length: SIG.length,
        sha256Prefix: sha256Prefix(SIG)
      })
    )
    expect(serialized).toContain(`"textSha256Prefix":"${sha256Prefix(REASONING)}"`)
    expect(serialized).toContain(`"textLength":${REASONING.length}`)
    expectNoLeak(serialized)
    expect(serialized).not.toContain(REASONING)
  })

  test('a redacted-bytes envelope is never written as raw bytes or base64', () => {
    logApiRequest(
      { body: { conversationState: { history: redactedBytesHistory() } } },
      getTimestamp()
    )

    const text = allLogText()
    expectNoLeak(text)
    expect(text).toContain(`"byteLength":${REDACTED_BYTES.byteLength}`)
    expect(text).toContain(sha256Prefix(REDACTED_BYTES))
  })

  test('logApiError redacts both the request and the response record', () => {
    const prep = signedPrep()
    logApiError(
      { email: 'user@example.com', body: { conversationState: prep.conversationState } },
      {
        status: 400,
        error: 'ValidationException',
        envelope: { kind: 'reasoningText', text: REASONING, signature: SIG }
      },
      getTimestamp()
    )

    expectNoLeak(allLogText())
  })

  test('non-reasoning binary payloads are still base64-encoded for debugging', () => {
    const imageBytes = new Uint8Array([1, 2, 3, 4, 5])
    logApiRequest(
      { body: { images: [{ format: 'png', source: { bytes: imageBytes } }] } },
      getTimestamp()
    )

    expect(allLogText()).toContain(Buffer.from(imageBytes).toString('base64'))
  })
})

describe('§6.8 redaction — plugin log sink', () => {
  test('logging a signed conversationState through error() leaks nothing', () => {
    const prep = signedPrep()
    logError('prepared request', { conversationState: prep.conversationState })

    const text = allLogText()
    expect(text).toContain('ERROR: prepared request')
    expectNoLeak(text)
    expect(text).toContain(sha256Prefix(SIG))
  })

  test('a bare signature-bearing envelope logged as a diagnostic is redacted', () => {
    logError('envelope diagnostic', {
      envelope: { kind: 'reasoningText', text: REASONING, signature: SIG },
      redactedContent: REDACTED_BYTES
    })

    expectNoLeak(allLogText())
  })
})

describe('§6.8 redaction — outbound request log payload', () => {
  test('the production payload carries only a sanitized reasoning summary', () => {
    const prep = signedPrep()
    const payload = buildSdkRequestLogPayload(prep, { email: 'user@example.com' })
    const serialized = JSON.stringify(payload)

    expectNoLeak(serialized)
    expect(serialized).not.toContain(REASONING)
    expect(serialized).toContain('"historyReasoning"')
    expect(serialized).toContain(sha256Prefix(SIG))
    expect(serialized).toContain(`"historyLength":${prep.conversationState.history?.length ?? 0}`)
    expect(serialized).toContain('"currentMessage"')
  })

  test('a request with no reasoning omits the summary entirely', () => {
    reasoningCorrelationCache.clearAllForTests()
    const prep = transformToSdkRequest(
      { messages: [{ role: 'user', content: 'question' }] },
      MODEL,
      auth
    )
    const serialized = JSON.stringify(buildSdkRequestLogPayload(prep, { email: 'u@example.com' }))
    expect(serialized).not.toContain('historyReasoning')
  })
})

describe('§6.8 redaction — thrown errors', () => {
  test('describeReasoningContentForLog never returns the signature or the bytes', () => {
    const text = JSON.stringify([
      describeReasoningContentForLog({ reasoningText: { text: REASONING, signature: SIG } }),
      describeReasoningContentForLog({ kind: 'reasoningText', text: REASONING, signature: SIG }),
      describeReasoningContentForLog({ redactedContent: REDACTED_BYTES }),
      describeReasoningContentForLog({ kind: 'redactedContent', bytes: REDACTED_BYTES })
    ])
    expectNoLeak(text)
    expect(text).not.toContain(REASONING)
  })

  test('UpstreamUnexpectedError serializes no reasoning metadata from its cause', async () => {
    const prep = signedPrep()
    const cause = Object.assign(new Error('stream died'), {
      conversationState: prep.conversationState
    })
    const err = new UpstreamUnexpectedError(cause, false)

    expectNoLeak(JSON.stringify(err.toPayload()))
    expectNoLeak(await err.toResponse().text())
    expectNoLeak(JSON.stringify(err, Object.keys(err)))
  })
})

describe('§6.8 redaction — structural guards', () => {
  test('a shared non-cyclic child is redacted twice, not mistaken for a cycle', () => {
    const shared = { reasoningContent: { reasoningText: { text: REASONING, signature: SIG } } }
    logApiRequest({ first: shared, second: shared }, getTimestamp())

    const text = allLogText()
    expectNoLeak(text)
    expect(text).not.toContain('circular')
    const occurrences = text.split(sha256Prefix(SIG)).length - 1
    expect(occurrences).toBe(2)
  })

  test('the log sinks pull in no storage, database, or lock module', () => {
    const sources = ['../plugin/logger.ts', '../plugin/log-redaction.ts'].map((relative) =>
      readFileSync(join(import.meta.dir, relative), 'utf8')
    )
    for (const source of sources) {
      expect(source).not.toContain('storage/')
      expect(source).not.toContain('infrastructure/database')
      expect(source).not.toContain('proper-lockfile')
    }
  })
})

type Variant = 'info' | 'warning' | 'success' | 'error'
const noToast = (_message: string, _variant: Variant): void => {}
const KIRO_URL = 'https://q.us-east-1.amazonaws.com/generateAssistantResponse'

function makeAccount(): ManagedAccount {
  return {
    id: 'acct-A',
    email: 'acct-a@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: 'refresh-acct-A',
    accessToken: 'access-acct-A',
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0
  }
}

function wireHandler(
  prep: SdkPreparedRequest,
  send: () => Promise<unknown>,
  configOverrides: Record<string, unknown> = {}
): RequestHandler {
  const account = makeAccount()
  const accountManager: any = {
    getAccounts: () => [account],
    getAccountCount: () => 1,
    markUnhealthy: mock(() => {}),
    markRateLimited: mock(() => {}),
    toAuthDetails: (acc: ManagedAccount) => ({
      access: acc.accessToken,
      refresh: acc.refreshToken,
      expires: acc.expiresAt,
      authMethod: 'idc',
      region: acc.region,
      email: acc.email
    })
  }
  const config: any = {
    max_request_iterations: 4,
    request_timeout_ms: 60000,
    stream_event_timeout_enabled: false,
    stream_buffer_until_complete: false,
    stream_max_attempts: 1,
    sdk_response_timeout_enabled: false,
    sdk_response_timeout_ms: 300000,
    rate_limit_max_retries: 1,
    rate_limit_retry_delay_ms: 1,
    enable_log_effort_debug: false,
    enable_log_api_request: true,
    auto_effort_mapping: false,
    token_expiry_buffer_ms: 120000,
    auto_sync_kiro_cli: false,
    account_selection_strategy: 'sticky',
    ...configOverrides
  }
  const handler = new RequestHandler(accountManager, config, {
    save: mock(async () => {}),
    batchSave: mock(async () => {})
  } as any)
  const internals = handler as any
  internals.accountSelector = {
    selectHealthyAccount: mock(async () => account),
    selectAlternativeAccount: mock(async () => null)
  }
  internals.tokenRefresher = {
    refreshIfNeeded: mock(async (acc: ManagedAccount) => ({ shouldContinue: false, account: acc })),
    forceRefresh: mock(async () => ({ ok: true, dead: false }))
  }
  internals.usageTracker = { syncUsage: mock(async () => {}) }
  internals.prepareSdkRequest = () => prep
  internals.makeSdkClient = () => ({ send })
  return handler
}

function streamingPrep(): SdkPreparedRequest {
  return { ...signedPrep(), streaming: true }
}

function sdkStreamOf(events: unknown[], failure?: Error): () => Promise<unknown> {
  return async () => ({
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
      if (failure) throw failure
    })()
  })
}

async function drain(response: Response): Promise<void> {
  const reader = response.body!.getReader()
  try {
    while (!(await reader.read()).done) {}
  } catch {}
}

describe('§6.8 redaction — stream observability fields', () => {
  test('failure-log channel fields carry volume only, never reasoning or reply text', async () => {
    const handler = wireHandler(
      streamingPrep(),
      sdkStreamOf(
        [
          { reasoningContentEvent: { text: REASONING } },
          { assistantResponseEvent: { content: STREAMED_REPLY } }
        ],
        new Error('stream died after output')
      )
    )

    await drain(
      await handler.handle(
        KIRO_URL,
        { body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'go' }] }) },
        noToast
      )
    )

    const text = allLogText()
    expect(text).toContain(`"emittedReasoningChars":${REASONING.length}`)
    expect(text).toContain(`"emittedVisibleChars":${STREAMED_REPLY.length}`)
    expect(text).toContain('"emittedToolCount":0')
    expect(text).toContain('"sawToolIntent":false')
    expect(text).not.toContain(REASONING)
    expect(text).not.toContain(STREAMED_REPLY)
    expectNoLeak(text)
  })

  test('recovery-path retry and terminal logs carry volume only', async () => {
    let sends = 0
    const handler = wireHandler(
      streamingPrep(),
      async () => {
        sends++
        const attempt = sends
        return {
          generateAssistantResponseResponse: (async function* () {
            yield { reasoningContentEvent: { text: REASONING } }
            throw new Error(`recovery attempt ${attempt} died`)
          })()
        }
      },
      { stream_max_attempts: 2, stream_recovery_mode: 'reasoning_restart' }
    )
    ;(handler as unknown as { sleep: () => Promise<void> }).sleep = async () => {}

    await drain(
      await handler.handle(
        KIRO_URL,
        { body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'go' }] }) },
        noToast
      )
    )

    expect(sends).toBe(2)
    const text = allLogText()
    expect(text).toContain('"outcome":"retrying"')
    expect(text).toContain('"outcome":"terminated_after_output"')
    expect(text).toContain(`"emittedReasoningChars":${REASONING.length}`)
    expect(text).toContain('"emittedVisibleChars":0')
    expect(text).not.toContain(REASONING)
    expectNoLeak(text)
  })

  test('exact replay telemetry carries matched volumes only, never replay text', async () => {
    const SHADOW_REPLY = `${STREAMED_REPLY.slice(0, -3)}LOG`
    const MATCHED = STREAMED_REPLY.length - 3
    let sends = 0
    const handler = wireHandler(
      streamingPrep(),
      async () => {
        sends++
        const failing = sends === 1
        return {
          generateAssistantResponseResponse: (async function* () {
            yield { reasoningContentEvent: { text: REASONING } }
            yield { assistantResponseEvent: { content: failing ? STREAMED_REPLY : SHADOW_REPLY } }
            if (failing) throw new Error('reset after visible output')
          })()
        }
      },
      { stream_max_attempts: 2, stream_recovery_mode: 'exact_replay' }
    )
    ;(handler as unknown as { sleep: () => Promise<void> }).sleep = async () => {}

    await drain(
      await handler.handle(
        KIRO_URL,
        { body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'go' }] }) },
        noToast
      )
    )

    expect(sends).toBe(2)
    const text = allLogText()
    expect(text).toContain('Kiro exact replay attempt finished')
    expect(text).toContain('"replayOutcome":"diverged"')
    expect(text).toContain('"divergenceChannel":"text"')
    expect(text).toContain(`"matchedReasoningChars":${REASONING.length}`)
    expect(text).toContain(`"matchedVisibleChars":${MATCHED}`)
    expect(text).not.toContain(REASONING)
    expect(text).not.toContain(STREAMED_REPLY)
    expect(text).not.toContain(SHADOW_REPLY)
    expectNoLeak(text)
  })

  test('the missing-completion-metadata marker carries volume only', async () => {
    const handler = wireHandler(
      streamingPrep(),
      sdkStreamOf([
        { reasoningContentEvent: { text: REASONING } },
        { assistantResponseEvent: { content: STREAMED_REPLY } }
      ])
    )

    await drain(
      await handler.handle(
        KIRO_URL,
        { body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'go' }] }) },
        noToast
      )
    )

    const text = allLogText()
    expect(text).toContain('Kiro stream ended without completion metadata')
    expect(text).toContain(`"emittedVisibleChars":${STREAMED_REPLY.length}`)
    expect(text).not.toContain(REASONING)
    expect(text).not.toContain(STREAMED_REPLY)
    expectNoLeak(text)
  })
})

describe('§6.8 redaction — end to end with enable_log_api_request', () => {
  test('an SDK error thrown while a signed history is in flight leaks nothing', async () => {
    const prep = signedPrep()
    const sdkError = Object.assign(new Error('Invalid signature in thinking block'), {
      name: 'ValidationException',
      $metadata: { httpStatusCode: 400 },
      reason: 'THINKING_SIGNATURE_INVALID'
    })
    const handler = wireHandler(prep, async () => {
      throw sdkError
    })

    const response = await handler.handle(
      KIRO_URL,
      { body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'go' }] }) },
      noToast
    )

    expectNoLeak(await response.text())
    const text = allLogText()
    expect(text.length).toBeGreaterThan(0)
    expectNoLeak(text)
    expect(text).toContain(sha256Prefix(SIG))
  })
})
