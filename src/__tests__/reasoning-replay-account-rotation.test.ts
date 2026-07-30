/**
 * Wave 6 live-verification checkbox, offline half: multi-account rotation with replay active.
 *
 * The unit-level fact ("produced on account A, consumed on account B still hits — account is
 * not in the key", `reasoning-correlation-cache.test.ts`) exercises the cache in isolation.
 * §3.2 separately measured at the AWS level that a signature produced under account A is
 * accepted with account B's token. Neither drives the PLUGIN across a rotation.
 *
 * These tests do: a real `AccountManager` in `round-robin` mode, the real `AccountSelector`
 * constructed by `RequestHandler`, the real `prepareSdkRequest`/`transformToSdkRequest`, and
 * the real streaming `ResponseHandler`. Only the SDK client, token refresher and usage tracker
 * are stubbed, so the rotation itself and the request rebuild are genuine. The assertion is on
 * the OUTBOUND CodeWhisperer body of the second request: it must carry the byte-exact nested
 * `reasoningContent` captured while account A was selected, while being sent with account B's
 * access token.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { RequestHandler } from '../core/request/request-handler.js'
import { AccountManager } from '../plugin/accounts.js'
import { reasoningCorrelationCache } from '../plugin/reasoning/correlation-cache.js'
import type { CodeWhispererRequest, ManagedAccount } from '../plugin/types.js'

const MODEL = 'claude-opus-5'
const KIRO_URL = `https://q.us-east-1.amazonaws.com/generateAssistantResponse`
const SIG = `sig-${'A'.repeat(320)}`
const REASONING = 'step one: read the file, then decide'
const VISIBLE = 'calling the tool now'
const TOOL_USE_ID = 'tu-rotation-root'
const TOOL_NAME = 'read_file'
const TOOL_ARGS = '{"path":"a.ts"}'

type Variant = 'info' | 'warning' | 'success' | 'error'
const noToast = (_message: string, _variant: Variant): void => {}

function makeAccount(id: string): ManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: 'idc',
    region: 'us-east-1',
    // The real `AccountManager.toAuthDetails` encodes an IDC refresh token, which requires
    // both OIDC client credentials — omitting them throws before any request is built.
    clientId: `client-${id}`,
    clientSecret: `secret-${id}`,
    profileArn: `arn:aws:codewhisperer:us-east-1:000000000000:profile/${id}`,
    refreshToken: `refresh-${id}`,
    accessToken: `access-${id}`,
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0
  }
}

const baseConfig = {
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
  enable_log_api_request: false,
  auto_effort_mapping: false,
  token_expiry_buffer_ms: 120000,
  auto_sync_kiro_cli: false,
  account_selection_strategy: 'round-robin'
} as never

function sdkResponse(events: readonly unknown[]): unknown {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
    })()
  }
}

/** A tool-emitting turn: reasoning text, a signature, visible text, one tool use. */
const producingTurnEvents: readonly unknown[] = [
  { reasoningContentEvent: { text: REASONING } },
  { reasoningContentEvent: { signature: SIG } },
  { assistantResponseEvent: { content: VISIBLE } },
  { toolUseEvent: { toolUseId: TOOL_USE_ID, name: TOOL_NAME, input: TOOL_ARGS } },
  { toolUseEvent: { toolUseId: TOOL_USE_ID, name: TOOL_NAME, input: '', stop: true } },
  { metadataEvent: { tokenUsage: { inputTokens: 5, outputTokens: 2 } } }
]

/** The continuation turn: a plain final answer, no tools, so the loop tears down. */
const continuationTurnEvents: readonly unknown[] = [
  { reasoningContentEvent: { text: 'still reasoning after the rotation' } },
  { reasoningContentEvent: { signature: `${SIG}-second` } },
  { assistantResponseEvent: { content: 'final answer' } },
  { metadataEvent: { tokenUsage: { inputTokens: 9, outputTokens: 3 } } }
]

interface SentRequest {
  conversationState: CodeWhispererRequest['conversationState']
  profileArn?: string
  accessToken: string
  email?: string
  region: string
}

interface Wired {
  handler: RequestHandler
  sent: SentRequest[]
  accountManager: AccountManager
  refreshedAccountIds: string[]
}

function wireRotation(
  accounts: readonly ManagedAccount[],
  eventsPerCall: readonly (readonly unknown[])[]
): Wired {
  const accountManager = new AccountManager([...accounts], 'round-robin')
  const repository = {
    save: mock(async () => {}),
    batchSave: mock(async () => {}),
    invalidateCache: mock(() => {}),
    findAll: mock(async () => [])
  } as never
  const handler = new RequestHandler(accountManager, baseConfig, repository)
  const refreshedAccountIds: string[] = []
  const sent: SentRequest[] = []
  // `Object.assign` injects the seams without a cast: its `T & U` return type accepts source
  // keys the target does not declare, so no `as any` / `as unknown as` is needed to reach the
  // private fields.
  Object.assign(handler, {
    tokenRefresher: {
      refreshIfNeeded: mock(async (account: ManagedAccount) => {
        refreshedAccountIds.push(account.id)
        return { shouldContinue: false, account }
      }),
      forceRefresh: mock(async () => ({ ok: true, dead: false }))
    },
    usageTracker: { syncUsage: mock(async () => {}) },
    makeSdkClient: (
      auth: { access: string; email?: string },
      region: string
    ): { send: (command: { input: Record<string, unknown> }) => Promise<unknown> } => ({
      send: async (command) => {
        const input = command.input as {
          conversationState: CodeWhispererRequest['conversationState']
          profileArn?: string
        }
        sent.push({
          conversationState: input.conversationState,
          profileArn: input.profileArn,
          accessToken: auth.access,
          email: auth.email,
          region
        })
        return sdkResponse(eventsPerCall[sent.length - 1] ?? [])
      }
    })
  })
  return { handler, sent, accountManager, refreshedAccountIds }
}

function requireSent(sent: readonly SentRequest[], index: number): SentRequest {
  const request = sent[index]
  if (!request) throw new Error(`no outbound request was captured at index ${index}`)
  return request
}

/**
 * The exact inbound shape OpenCode echoes back mid tool loop. It must END on the tool
 * result: a trailing plain user turn closes the loop, `findActiveToolLoopStart` then returns
 * `msgs.length`, and Wave 1's bound suppresses reasoning recovery entirely — which would make
 * this test pass or fail for a reason unrelated to rotation.
 */
function inboundContinuationMessages(): unknown[] {
  return [
    { role: 'user', content: 'walk the chain' },
    {
      role: 'assistant',
      content: VISIBLE,
      reasoning_content: REASONING,
      tool_calls: [{ id: TOOL_USE_ID, function: { name: TOOL_NAME, arguments: TOOL_ARGS } }]
    },
    { role: 'tool', content: '{"ok":true}', tool_call_id: TOOL_USE_ID }
  ]
}

function body(messages: readonly unknown[]): string {
  return JSON.stringify({ model: MODEL, messages })
}

function assistantTurns(
  request: SentRequest
): NonNullable<
  CodeWhispererRequest['conversationState']['history']
>[number]['assistantResponseMessage'][] {
  return (request.conversationState.history ?? []).flatMap((entry) =>
    entry.assistantResponseMessage ? [entry.assistantResponseMessage] : []
  )
}

describe('multi-account rotation with reasoning replay active', () => {
  beforeEach(() => {
    reasoningCorrelationCache.clearAllForTests()
  })

  test('an envelope produced on account A replays on the outbound body sent with account B', async () => {
    const accountA = makeAccount('acct-a')
    const accountB = makeAccount('acct-b')
    const wired = wireRotation([accountA, accountB], [producingTurnEvents, continuationTurnEvents])

    // Request 1 — round-robin picks account A and the stream publishes the envelope.
    const first = await wired.handler.handle(
      KIRO_URL,
      { body: body([{ role: 'user', content: 'walk the chain' }]) },
      noToast
    )
    await first.text()

    expect(wired.sent).toHaveLength(1)
    expect(wired.sent[0]?.accessToken).toBe('access-acct-a')
    const published = reasoningCorrelationCache.lookup({
      reasoningText: REASONING,
      visibleText: VISIBLE,
      toolUses: [{ toolUseId: TOOL_USE_ID, name: TOOL_NAME, argumentsJson: TOOL_ARGS }],
      effectiveModel: MODEL
    })
    expect(published.envelope).toEqual({ kind: 'reasoningText', text: REASONING, signature: SIG })
    expect(published.metadata?.accountId).toBe('acct-a')

    // Request 2 — the SAME handler rotates to account B and must still replay.
    const second = await wired.handler.handle(
      KIRO_URL,
      { body: body(inboundContinuationMessages()) },
      noToast
    )
    await second.text()

    expect(wired.sent).toHaveLength(2)
    const outbound = requireSent(wired.sent, 1)
    // The rotation genuinely happened: different account, different token, different ARN.
    expect(outbound.accessToken).toBe('access-acct-b')
    expect(outbound.email).toBe('acct-b@example.com')
    expect(outbound.profileArn).toBe(accountB.profileArn)
    expect(outbound.accessToken).not.toBe(wired.sent[0]?.accessToken)

    const replayed = assistantTurns(outbound).find((turn) => turn?.reasoningContent !== undefined)
    expect(replayed?.reasoningContent).toEqual({
      reasoningText: { text: REASONING, signature: SIG }
    })
    // Byte-exact: the signature crossing the rotation is the one account A produced.
    expect(JSON.stringify(outbound.conversationState)).toContain(SIG)
    expect(JSON.stringify(outbound.conversationState)).not.toContain('reasoningSignature')
    // Mutual exclusivity survives the rotation.
    expect(replayed?.content).toBe(VISIBLE)
    expect(replayed?.content).not.toContain('<thinking>')
    // The tool use the signature belongs to is still attached to the same turn.
    expect(replayed?.toolUses?.[0]?.toolUseId).toBe(TOOL_USE_ID)
  })

  test('the replaying account is the one that rotated in, and it tears the loop down', async () => {
    const accountA = makeAccount('acct-a')
    const accountB = makeAccount('acct-b')
    const wired = wireRotation([accountA, accountB], [producingTurnEvents, continuationTurnEvents])

    await (
      await wired.handler.handle(
        KIRO_URL,
        { body: body([{ role: 'user', content: 'walk the chain' }]) },
        noToast
      )
    ).text()

    const fingerprint = {
      reasoningText: REASONING,
      visibleText: VISIBLE,
      toolUses: [{ toolUseId: TOOL_USE_ID, name: TOOL_NAME, argumentsJson: TOOL_ARGS }],
      effectiveModel: MODEL
    }
    // Producer recorded as metadata only — it is never a lookup filter.
    expect(reasoningCorrelationCache.lookup(fingerprint).metadata?.accountId).toBe('acct-a')

    await (
      await wired.handler.handle(KIRO_URL, { body: body(inboundContinuationMessages()) }, noToast)
    ).text()

    // Both accounts were exercised, in order, and each request refreshed only its own account.
    expect(wired.refreshedAccountIds).toEqual(['acct-a', 'acct-b'])
    expect(wired.sent.map((request) => request.accessToken)).toEqual([
      'access-acct-a',
      'access-acct-b'
    ])
    // The second turn was a no-tool final answer, so account B tore down account A's loop.
    expect(reasoningCorrelationCache.lookup(fingerprint).refusal).toBe('miss')
  })

  test('a single-account run is byte-identical to the rotated run on the replayed block', async () => {
    // Negative control for the rotation claim: if replay only worked without rotation, the
    // two outbound reasoning blocks would differ.
    const solo = wireRotation(
      [makeAccount('acct-a')],
      [producingTurnEvents, continuationTurnEvents]
    )
    await (
      await solo.handler.handle(
        KIRO_URL,
        { body: body([{ role: 'user', content: 'walk the chain' }]) },
        noToast
      )
    ).text()
    await (
      await solo.handler.handle(KIRO_URL, { body: body(inboundContinuationMessages()) }, noToast)
    ).text()
    const soloBlock = assistantTurns(requireSent(solo.sent, 1)).find(
      (turn) => turn?.reasoningContent !== undefined
    )?.reasoningContent

    reasoningCorrelationCache.clearAllForTests()

    const rotated = wireRotation(
      [makeAccount('acct-a'), makeAccount('acct-b')],
      [producingTurnEvents, continuationTurnEvents]
    )
    await (
      await rotated.handler.handle(
        KIRO_URL,
        { body: body([{ role: 'user', content: 'walk the chain' }]) },
        noToast
      )
    ).text()
    await (
      await rotated.handler.handle(KIRO_URL, { body: body(inboundContinuationMessages()) }, noToast)
    ).text()
    const rotatedBlock = assistantTurns(requireSent(rotated.sent, 1)).find(
      (turn) => turn?.reasoningContent !== undefined
    )?.reasoningContent

    expect(soloBlock).toBeDefined()
    expect(rotated.sent[1]?.accessToken).toBe('access-acct-b')
    expect(solo.sent[1]?.accessToken).toBe('access-acct-a')
    expect(JSON.stringify(rotatedBlock)).toBe(JSON.stringify(soloBlock))
  })
})
