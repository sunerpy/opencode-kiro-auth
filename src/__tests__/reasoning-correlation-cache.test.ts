import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { RequestHandler } from '../core/request/request-handler.js'
import {
  ResponseHandler,
  type SdkCompletionPayload,
  type SdkResponseLifecycle
} from '../core/request/response-handler.js'
import {
  DEFAULT_MAX_ENTRIES,
  ReasoningCorrelationCache,
  reasoningCorrelationCache
} from '../plugin/reasoning/correlation-cache.js'
import { EmittedOutputAccumulator } from '../plugin/reasoning/emitted-output.js'
import {
  computeFingerprintKey,
  deriveInheritedLoopId,
  loopIdFromToolUseIds,
  normalizeToolArguments,
  resolveLoop
} from '../plugin/reasoning/turn-identity.js'
import { transformToSdkRequest } from '../plugin/request.js'
import type {
  KiroAuthDetails,
  KiroReasoningContent,
  ManagedAccount,
  SdkPreparedRequest
} from '../plugin/types.js'

const SIG_A = `sig-${'A'.repeat(320)}`
const SIG_B = `sig-${'B'.repeat(320)}`

function textEnvelope(
  text: string,
  signature: string
): Extract<KiroReasoningContent, { kind: 'reasoningText' }> {
  return { kind: 'reasoningText', text, signature }
}

function makeSdkResponse(events: unknown[]): any {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
    })()
  }
}

function makeFailingSdkResponse(events: unknown[], error: Error): any {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
      throw error
    })()
  }
}

function toolLoopEvents(signature: string): unknown[] {
  return [
    { reasoningContentEvent: { text: 'step one, then call the tool' } },
    { reasoningContentEvent: { signature } },
    { assistantResponseEvent: { content: 'calling the tool now' } },
    { toolUseEvent: { toolUseId: 'tu-root-1', name: 'read_file', input: '{"path":"a.ts"}' } },
    { toolUseEvent: { toolUseId: 'tu-root-1', name: 'read_file', input: '', stop: true } },
    { metadataEvent: { tokenUsage: { inputTokens: 5, outputTokens: 2 } } }
  ]
}

async function drain(response: Response): Promise<string> {
  return response.text()
}

describe('EmittedOutputAccumulator — fingerprint source is emitted OpenAI output', () => {
  test('accumulates visible content, reasoning and assembled tool calls', () => {
    const acc = new EmittedOutputAccumulator()
    acc.observeChunk({ choices: [{ delta: { reasoning_content: 'thi' } }] })
    acc.observeChunk({ choices: [{ delta: { reasoning_content: 'nking' } }] })
    acc.observeChunk({ choices: [{ delta: { content: 'Hello ' } }] })
    acc.observeChunk({ choices: [{ delta: { content: 'world' } }] })
    acc.observeChunk({
      choices: [
        { delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'f', arguments: '' } }] } }
      ]
    })
    acc.observeChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }]
    })
    acc.observeChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }]
    })

    expect(acc.reasoningText).toBe('thinking')
    expect(acc.visibleText).toBe('Hello world')
    expect(acc.toolUses()).toEqual([{ toolUseId: 't1', name: 'f', argumentsJson: '{"a":1}' }])
  })

  test('non-chunk shapes are ignored without throwing', () => {
    const acc = new EmittedOutputAccumulator()
    acc.observeChunk(null)
    acc.observeChunk('data')
    acc.observeChunk({ choices: [] })
    acc.observeChunk({ choices: [{}] })
    acc.observeChunk({ choices: [{ delta: { tool_calls: 'nope' } }] })
    expect(acc.visibleText).toBe('')
    expect(acc.toolUses()).toEqual([])
  })

  test('a text-dialect tool call is captured post-DialectGate, not as visible text', async () => {
    const dialect =
      '<function_calls><invoke name="write_note"><parameter name="body">hi</parameter></invoke></function_calls>'
    const acc = new EmittedOutputAccumulator()
    const lifecycle: SdkResponseLifecycle = {
      attemptId: 'a1',
      effectiveModel: 'claude-opus-5',
      onComplete() {}
    }
    const response = await new ResponseHandler().handleSdkSuccess(
      makeSdkResponse([{ assistantResponseEvent: { content: `before ${dialect}` } }]),
      'claude-opus-5',
      'conv-dialect',
      true,
      lifecycle
    )
    const body = await drain(response)
    for (const line of body.split('\n\n')) {
      if (!line.startsWith('data: ')) continue
      acc.observeChunk(JSON.parse(line.slice('data: '.length)))
    }

    expect(acc.visibleText).not.toContain('<invoke')
    expect(acc.visibleText).toBe('before ')
    const tools = acc.toolUses()
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('write_note')
    expect(tools[0]!.argumentsJson).toBe(JSON.stringify({ body: 'hi' }))
    expect(tools[0]!.toolUseId.length).toBeGreaterThan(0)
  })
})

describe('turn identity — loopId derivation', () => {
  test('an empty tool-use id refuses to produce a loop root', () => {
    expect(loopIdFromToolUseIds(['a', ''])).toBeUndefined()
    expect(loopIdFromToolUseIds([])).toBeUndefined()
    expect(loopIdFromToolUseIds(['a', 'b'])).toBe('loop:a,b')
  })

  test('ordering matters — two roots with swapped ids are different loops', () => {
    expect(loopIdFromToolUseIds(['a', 'b'])).not.toBe(loopIdFromToolUseIds(['b', 'a']))
  })

  test('inherited loop id is recovered from the first assistant turn of the trailing loop', () => {
    const messages = [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', tool_calls: [{ id: 'root-1' }, { id: 'root-2' }] },
      { role: 'tool', tool_call_id: 'root-1', content: 'ok' },
      { role: 'tool', tool_call_id: 'root-2', content: 'ok' },
      { role: 'assistant', tool_calls: [{ id: 'later-1' }] },
      { role: 'tool', tool_call_id: 'later-1', content: 'ok' }
    ]
    expect(deriveInheritedLoopId(messages)).toBe('loop:root-1,root-2')
  })

  test('two byte-identical opening prompts yield different loop ids', () => {
    const prompt = { role: 'user', content: 'identical opening prompt' }
    const a = deriveInheritedLoopId([
      prompt,
      { role: 'assistant', tool_calls: [{ id: 'agent-a-1' }] },
      { role: 'tool', tool_call_id: 'agent-a-1', content: 'r' }
    ])
    const b = deriveInheritedLoopId([
      prompt,
      { role: 'assistant', tool_calls: [{ id: 'agent-b-1' }] },
      { role: 'tool', tool_call_id: 'agent-b-1', content: 'r' }
    ])
    expect(a).toBe('loop:agent-a-1')
    expect(b).toBe('loop:agent-b-1')
    expect(a).not.toBe(b)
  })

  test('a history whose loop root was removed by compaction yields no loop id', () => {
    const compacted = [
      { role: 'tool', tool_call_id: 'orphan-1', content: 'result with no root turn' }
    ]
    expect(deriveInheritedLoopId(compacted)).toBeUndefined()
  })

  test('a plain chat history that does not end in a tool loop yields no loop id', () => {
    expect(
      deriveInheritedLoopId([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'again' }
      ])
    ).toBeUndefined()
    expect(deriveInheritedLoopId(undefined)).toBeUndefined()
    expect(deriveInheritedLoopId([])).toBeUndefined()
  })

  test('a first assistant turn with no tool uses gives no loop id', () => {
    expect(
      deriveInheritedLoopId([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'plain answer' }
      ])
    ).toBeUndefined()
  })

  test('resolveLoop implements the §6.3 decision table', () => {
    const tool = [{ toolUseId: 'x1', name: 'f', argumentsJson: '{}' }]
    expect(resolveLoop(undefined, tool)).toEqual({ loopId: 'loop:x1', action: 'publish' })
    expect(resolveLoop('loop:root', tool)).toEqual({ loopId: 'loop:root', action: 'publish' })
    expect(resolveLoop('loop:root', [])).toEqual({ loopId: 'loop:root', action: 'teardown' })
    expect(resolveLoop(undefined, [])).toEqual({ action: 'none' })
    expect(resolveLoop('loop:root', [{ toolUseId: '', name: 'f', argumentsJson: '{}' }])).toEqual({
      action: 'none'
    })
  })
})

describe('fingerprint key', () => {
  const base = {
    reasoningText: 'why',
    visibleText: 'answer',
    toolUses: [{ toolUseId: 't1', name: 'read', argumentsJson: '{"p":1}' }],
    effectiveModel: 'claude-opus-5'
  }

  test('identical input yields an identical key', () => {
    expect(computeFingerprintKey(base)).toBe(computeFingerprintKey({ ...base }))
  })

  test('same arguments to two different tool names are distinct keys', () => {
    const other = {
      ...base,
      toolUses: [{ toolUseId: 't1', name: 'write', argumentsJson: '{"p":1}' }]
    }
    expect(computeFingerprintKey(other)).not.toBe(computeFingerprintKey(base))
  })

  test('the model namespaces the key', () => {
    expect(computeFingerprintKey({ ...base, effectiveModel: 'claude-sonnet-5' })).not.toBe(
      computeFingerprintKey(base)
    )
  })

  test('a one-character text difference is a different key — no fuzzy matching', () => {
    expect(computeFingerprintKey({ ...base, visibleText: 'answer ' })).not.toBe(
      computeFingerprintKey(base)
    )
    expect(computeFingerprintKey({ ...base, reasoningText: 'wHy' })).not.toBe(
      computeFingerprintKey(base)
    )
  })

  test('field boundaries cannot be forged by payload contents', () => {
    const a = computeFingerprintKey({ ...base, reasoningText: 'ab', visibleText: 'c' })
    const b = computeFingerprintKey({ ...base, reasoningText: 'a', visibleText: 'bc' })
    expect(a).not.toBe(b)
  })

  test('normalizeToolArguments is idempotent and passes unparseable payloads verbatim', () => {
    expect(normalizeToolArguments('{ "a" : 1 }')).toBe('{"a":1}')
    expect(normalizeToolArguments(normalizeToolArguments('{ "a" : 1 }'))).toBe('{"a":1}')
    expect(normalizeToolArguments('not json')).toBe('not json')
    expect(normalizeToolArguments(undefined)).toBe('')
  })
})

describe('ReasoningCorrelationCache', () => {
  const fp = (over: Partial<Parameters<typeof computeFingerprintKey>[0]> = {}) => ({
    reasoningText: 'thought',
    visibleText: 'reply',
    toolUses: [{ toolUseId: 't1', name: 'read', argumentsJson: '{}' }],
    effectiveModel: 'claude-opus-5',
    ...over
  })

  test('publish then lookup returns the envelope and records the account as metadata only', () => {
    const cache = new ReasoningCorrelationCache()
    cache.publish({
      ...fp(),
      envelope: textEnvelope('thought', SIG_A),
      loopId: 'loop:t1',
      accountId: 'acct-A',
      attemptId: 'att-1'
    })
    const hit = cache.lookup(fp())
    expect(hit.envelope).toEqual(textEnvelope('thought', SIG_A))
    expect(hit.metadata?.accountId).toBe('acct-A')
    expect(hit.refusal).toBeUndefined()
  })

  test('produced on account A, consumed on account B still hits — account is not in the key', () => {
    const cache = new ReasoningCorrelationCache()
    cache.publish({
      ...fp(),
      envelope: textEnvelope('thought', SIG_A),
      loopId: 'loop:t1',
      accountId: 'acct-A',
      attemptId: 'att-1'
    })
    expect(cache.lookup(fp()).envelope).toEqual(textEnvelope('thought', SIG_A))
  })

  test('reads are non-consuming — the same envelope serves two turns', () => {
    const cache = new ReasoningCorrelationCache()
    cache.publish({
      ...fp(),
      envelope: textEnvelope('thought', SIG_A),
      loopId: 'loop:t1',
      accountId: 'acct-A',
      attemptId: 'att-1'
    })
    expect(cache.lookup(fp()).envelope).toBeDefined()
    expect(cache.lookup(fp()).envelope).toBeDefined()
    expect(cache.size).toBe(1)
  })

  test('two envelopes under one key refuse — ambiguity is never resolved', () => {
    const cache = new ReasoningCorrelationCache()
    cache.publish({
      ...fp(),
      envelope: textEnvelope('thought', SIG_A),
      loopId: 'loop:t1',
      accountId: 'acct-A',
      attemptId: 'att-1'
    })
    cache.publish({
      ...fp(),
      envelope: textEnvelope('thought', SIG_B),
      loopId: 'loop:t1',
      accountId: 'acct-A',
      attemptId: 'att-2'
    })
    const result = cache.lookup(fp())
    expect(result.refusal).toBe('ambiguous')
    expect(result.envelope).toBeUndefined()
  })

  test('two envelopes differing ONLY by producing account refuse — no current-account preference', () => {
    const cache = new ReasoningCorrelationCache()
    cache.publish({
      ...fp(),
      envelope: textEnvelope('thought', SIG_A),
      loopId: 'loop:t1',
      accountId: 'acct-A',
      attemptId: 'att-1'
    })
    cache.publish({
      ...fp(),
      envelope: textEnvelope('thought', SIG_B),
      loopId: 'loop:t1',
      accountId: 'acct-B',
      attemptId: 'att-2'
    })
    expect(cache.lookup(fp()).refusal).toBe('ambiguous')
  })

  test('re-publishing a byte-identical capture is not ambiguity', () => {
    const cache = new ReasoningCorrelationCache()
    const input = {
      ...fp(),
      envelope: textEnvelope('thought', SIG_A),
      loopId: 'loop:t1',
      accountId: 'acct-A',
      attemptId: 'att-1'
    }
    cache.publish(input)
    cache.publish({ ...input, attemptId: 'att-2' })
    expect(cache.size).toBe(1)
    expect(cache.lookup(fp()).envelope).toEqual(textEnvelope('thought', SIG_A))
  })

  test('a near-miss fingerprint misses — no prefix or fuzzy match', () => {
    const cache = new ReasoningCorrelationCache()
    cache.publish({
      ...fp(),
      envelope: textEnvelope('thought', SIG_A),
      loopId: 'loop:t1',
      accountId: 'acct-A',
      attemptId: 'att-1'
    })
    expect(cache.lookup(fp({ visibleText: 'reply.' })).refusal).toBe('miss')
    expect(cache.lookup(fp({ reasoningText: 'thought ' })).refusal).toBe('miss')
    expect(
      cache.lookup(fp({ toolUses: [{ toolUseId: 't2', name: 'read', argumentsJson: '{}' }] }))
        .refusal
    ).toBe('miss')
  })

  test('a mid-conversation model switch misses via the model namespace', () => {
    const cache = new ReasoningCorrelationCache()
    cache.publish({
      ...fp(),
      envelope: textEnvelope('thought', SIG_A),
      loopId: 'loop:t1',
      accountId: 'acct-A',
      attemptId: 'att-1'
    })
    expect(cache.lookup(fp({ effectiveModel: 'claude-sonnet-5' })).refusal).toBe('miss')
  })

  test('TTL expiry degrades to a plain miss without error', () => {
    let now = 1_000
    const cache = new ReasoningCorrelationCache({ ttlMs: 100, now: () => now })
    cache.publish({
      ...fp(),
      envelope: textEnvelope('thought', SIG_A),
      loopId: 'loop:t1',
      accountId: 'acct-A',
      attemptId: 'att-1'
    })
    now = 1_050
    expect(cache.lookup(fp()).envelope).toBeDefined()
    now = 1_200
    expect(cache.lookup(fp()).refusal).toBe('miss')
    expect(cache.size).toBe(0)
  })

  test('the global entry cap evicts the oldest entry', () => {
    const cache = new ReasoningCorrelationCache({ maxEntries: 2, maxEntriesPerLoop: 10 })
    for (let i = 0; i < 3; i++) {
      cache.publish({
        ...fp({ visibleText: `reply-${i}` }),
        envelope: textEnvelope('thought', `${SIG_A}-${i}`),
        loopId: `loop:${i}`,
        accountId: 'acct-A',
        attemptId: `att-${i}`
      })
    }
    expect(cache.size).toBe(2)
    expect(cache.lookup(fp({ visibleText: 'reply-0' })).refusal).toBe('miss')
    expect(cache.lookup(fp({ visibleText: 'reply-2' })).envelope).toBeDefined()
  })

  test('the per-loop cap bounds one loop without evicting another', () => {
    const cache = new ReasoningCorrelationCache({ maxEntries: 100, maxEntriesPerLoop: 2 })
    for (let i = 0; i < 3; i++) {
      cache.publish({
        ...fp({ visibleText: `hot-${i}` }),
        envelope: textEnvelope('thought', `${SIG_A}-${i}`),
        loopId: 'loop:hot',
        accountId: 'acct-A',
        attemptId: `att-${i}`
      })
    }
    cache.publish({
      ...fp({ visibleText: 'cold' }),
      envelope: textEnvelope('thought', SIG_B),
      loopId: 'loop:cold',
      accountId: 'acct-A',
      attemptId: 'att-cold'
    })
    expect(cache.sizeForLoop('loop:hot')).toBe(2)
    expect(cache.sizeForLoop('loop:cold')).toBe(1)
    expect(cache.lookup(fp({ visibleText: 'cold' })).envelope).toBeDefined()
  })

  test('two concurrent loops stay isolated and clearLoop touches only one', () => {
    const cache = new ReasoningCorrelationCache()
    cache.publish({
      ...fp({ visibleText: 'loop-a-reply' }),
      envelope: textEnvelope('thought', SIG_A),
      loopId: 'loop:a',
      accountId: 'acct-A',
      attemptId: 'att-a'
    })
    cache.publish({
      ...fp({ visibleText: 'loop-b-reply' }),
      envelope: textEnvelope('thought', SIG_B),
      loopId: 'loop:b',
      accountId: 'acct-A',
      attemptId: 'att-b'
    })

    cache.clearLoop('loop:a')

    expect(cache.lookup(fp({ visibleText: 'loop-a-reply' })).refusal).toBe('miss')
    expect(cache.lookup(fp({ visibleText: 'loop-b-reply' })).envelope).toEqual(
      textEnvelope('thought', SIG_B)
    )
    expect(cache.sizeForLoop('loop:b')).toBe(1)
  })

  test('clearing an unknown loop is a no-op, never a global sweep', () => {
    const cache = new ReasoningCorrelationCache()
    cache.publish({
      ...fp(),
      envelope: textEnvelope('thought', SIG_A),
      loopId: 'loop:t1',
      accountId: 'acct-A',
      attemptId: 'att-1'
    })
    cache.clearLoop('loop:nonexistent')
    expect(cache.lookup(fp()).envelope).toBeDefined()
  })

  test('default bounds are explicit and small', () => {
    expect(DEFAULT_MAX_ENTRIES).toBeGreaterThan(0)
    expect(DEFAULT_MAX_ENTRIES).toBeLessThanOrEqual(256)
  })
})

describe('SdkResponseLifecycle.onComplete payload — all three call sites', () => {
  const captured: SdkCompletionPayload[] = []
  const lifecycle = (over: Partial<SdkResponseLifecycle> = {}): SdkResponseLifecycle => ({
    attemptId: 'attempt-1',
    effectiveModel: 'claude-opus-5',
    onComplete(completed) {
      captured.push(completed)
    },
    ...over
  })

  beforeEach(() => {
    captured.length = 0
  })

  test('buffered mode (bufferUntilComplete) publishes a full payload', async () => {
    const response = await new ResponseHandler().handleSdkSuccess(
      makeSdkResponse(toolLoopEvents(SIG_A)),
      'claude-opus-5',
      'conv-buffered',
      true,
      lifecycle({ bufferUntilComplete: true })
    )
    await drain(response)

    expect(captured).toHaveLength(1)
    const payload = captured[0]!
    expect(payload.envelope).toEqual(textEnvelope('step one, then call the tool', SIG_A))
    expect(payload.visibleText).toBe('calling the tool now')
    expect(payload.toolUses).toEqual([
      { toolUseId: 'tu-root-1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' }
    ])
    expect(payload.attemptId).toBe('attempt-1')
    expect(payload.loopId).toBe('loop:tu-root-1')
    expect(payload.effectiveModel).toBe('claude-opus-5')
  })

  test('the second buffered site (stream ends before any semantic chunk) still fires', async () => {
    const response = await new ResponseHandler().handleSdkSuccess(
      makeSdkResponse([]),
      'claude-opus-5',
      'conv-empty',
      true,
      lifecycle()
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]!.toolUses).toEqual([])
    expect(captured[0]!.loopId).toBeUndefined()
    expect(captured[0]!.visibleText).toBe('')
    expect(await drain(response)).toContain('"finish_reason":"stop"')
  })

  test('the LIVE pull-driven site (default mode) publishes the same payload', async () => {
    const response = await new ResponseHandler().handleSdkSuccess(
      makeSdkResponse(toolLoopEvents(SIG_A)),
      'claude-opus-5',
      'conv-live',
      true,
      lifecycle()
    )
    expect(captured).toHaveLength(0)
    await drain(response)

    expect(captured).toHaveLength(1)
    const payload = captured[0]!
    expect(payload.envelope).toEqual(textEnvelope('step one, then call the tool', SIG_A))
    expect(payload.loopId).toBe('loop:tu-root-1')
    expect(payload.toolUses).toEqual([
      { toolUseId: 'tu-root-1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' }
    ])
  })

  test('buffered and live modes produce byte-identical payloads', async () => {
    const handler = new ResponseHandler()
    await drain(
      await handler.handleSdkSuccess(
        makeSdkResponse(toolLoopEvents(SIG_A)),
        'claude-opus-5',
        'conv-cmp-live',
        true,
        lifecycle()
      )
    )
    await drain(
      await handler.handleSdkSuccess(
        makeSdkResponse(toolLoopEvents(SIG_A)),
        'claude-opus-5',
        'conv-cmp-buffered',
        true,
        lifecycle({ bufferUntilComplete: true })
      )
    )
    expect(captured).toHaveLength(2)
    expect(JSON.stringify(captured[0])).toBe(JSON.stringify(captured[1]))
  })

  test('an inherited loop id wins over the emitted ids', async () => {
    await drain(
      await new ResponseHandler().handleSdkSuccess(
        makeSdkResponse(toolLoopEvents(SIG_A)),
        'claude-opus-5',
        'conv-inherited',
        true,
        lifecycle({ inheritedLoopId: 'loop:original-root' })
      )
    )
    expect(captured[0]!.loopId).toBe('loop:original-root')
  })

  test('a plain no-tool response fires onComplete with loopId undefined', async () => {
    await drain(
      await new ResponseHandler().handleSdkSuccess(
        makeSdkResponse([
          { reasoningContentEvent: { text: 'brief thought' } },
          { reasoningContentEvent: { signature: SIG_A } },
          { assistantResponseEvent: { content: 'plain chat answer' } }
        ]),
        'claude-opus-5',
        'conv-plain',
        true,
        lifecycle()
      )
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]!.loopId).toBeUndefined()
    expect(captured[0]!.toolUses).toEqual([])
    expect(captured[0]!.envelope).toEqual(textEnvelope('brief thought', SIG_A))
  })

  test('conflicting signatures yield no envelope while the payload still fires', async () => {
    await drain(
      await new ResponseHandler().handleSdkSuccess(
        makeSdkResponse([
          { reasoningContentEvent: { text: 'thought', signature: SIG_A } },
          { reasoningContentEvent: { signature: SIG_B } },
          { assistantResponseEvent: { content: 'answer' } },
          { toolUseEvent: { toolUseId: 'tu-x', name: 'f', input: '{}', stop: true } }
        ]),
        'claude-opus-5',
        'conv-conflict',
        true,
        lifecycle()
      )
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]!.envelope).toBeUndefined()
    expect(captured[0]!.loopId).toBe('loop:tu-x')
  })

  test('unsigned reasoning yields no envelope', async () => {
    await drain(
      await new ResponseHandler().handleSdkSuccess(
        makeSdkResponse([
          { reasoningContentEvent: { text: 'unsigned thought' } },
          { assistantResponseEvent: { content: 'answer' } }
        ]),
        'claude-opus-5',
        'conv-unsigned',
        true,
        lifecycle()
      )
    )
    expect(captured[0]!.envelope).toBeUndefined()
  })

  test('a post-output stream failure publishes nothing', async () => {
    const response = await new ResponseHandler().handleSdkSuccess(
      makeFailingSdkResponse(
        [
          { reasoningContentEvent: { text: 'partial thought', signature: SIG_A } },
          { assistantResponseEvent: { content: 'partial answer' } }
        ],
        new Error('socket reset after output')
      ),
      'claude-opus-5',
      'conv-postfail',
      true,
      lifecycle({ mapError: (error) => error })
    )
    const reader = response.body!.getReader()
    await reader.read()
    await reader.read().catch(() => {})
    await reader.read().catch(() => {})
    expect(captured).toHaveLength(0)
  })

  test('the non-streaming path never invokes onComplete', async () => {
    const response = await new ResponseHandler().handleSdkSuccess(
      makeSdkResponse(toolLoopEvents(SIG_A)),
      'claude-opus-5',
      'conv-nonstreaming',
      false,
      lifecycle()
    )
    const body = await response.json()
    expect(body.choices[0].message.reasoning_content).toBe('step one, then call the tool')
    expect(captured).toHaveLength(0)
  })

  test('visible output is unchanged when no lifecycle is supplied at all', async () => {
    const withLifecycle = await drain(
      await new ResponseHandler().handleSdkSuccess(
        makeSdkResponse(toolLoopEvents(SIG_A)),
        'claude-opus-5',
        'conv-vis',
        true,
        lifecycle()
      )
    )
    const withoutLifecycle = await drain(
      await new ResponseHandler().handleSdkSuccess(
        makeSdkResponse(toolLoopEvents(SIG_A)),
        'claude-opus-5',
        'conv-vis',
        true
      )
    )
    const strip = (text: string): string => text.replace(/"created":\d+/g, '"created":0')
    expect(strip(withLifecycle)).toBe(strip(withoutLifecycle))
  })
})

type Variant = 'info' | 'warning' | 'success' | 'error'
const noToast = (_m: string, _v: Variant): void => {}
const KIRO_URL = 'https://q.us-east-1.amazonaws.com/generateAssistantResponse'

function makeAccount(id: string): ManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: `refresh-${id}`,
    accessToken: `access-${id}`,
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0
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
  rate_limit_retry_delay_ms: 10,
  enable_log_effort_debug: false,
  enable_log_api_request: false,
  effort: undefined,
  auto_effort_mapping: false,
  token_expiry_buffer_ms: 120000,
  auto_sync_kiro_cli: false,
  account_selection_strategy: 'sticky'
} as any

function cannedPrep(): SdkPreparedRequest {
  return {
    conversationState: { chatTriggerType: 'MANUAL', conversationId: 'c1' } as any,
    profileArn: 'arn:aws:test',
    streaming: true,
    effectiveModel: 'claude-opus-5',
    conversationId: 'c1',
    region: 'us-east-1'
  }
}

interface WiredHandler {
  handler: RequestHandler
  lifecycles: SdkResponseLifecycle[]
  account: ManagedAccount
  syncUsage: ReturnType<typeof mock>
}

function wireHandler(account: ManagedAccount, events: unknown[]): WiredHandler {
  const accountManager: any = {
    getAccounts: () => [account],
    markHealthy: () => {},
    toAuthDetails: (acc: ManagedAccount) => ({
      access: acc.accessToken,
      refresh: acc.refreshToken,
      expires: acc.expiresAt,
      authMethod: 'idc',
      region: acc.region,
      email: acc.email
    })
  }
  const repository: any = { save: mock(async () => {}) }
  const handler = new RequestHandler(accountManager, { ...baseConfig }, repository)
  const internals = handler as any
  internals.accountSelector = {
    selectHealthyAccount: mock(async () => account),
    selectAlternativeAccount: mock(async () => null)
  }
  internals.tokenRefresher = {
    refreshIfNeeded: mock(async (acc: ManagedAccount) => ({ shouldContinue: false, account: acc })),
    forceRefresh: mock(async () => ({ ok: true, dead: false }))
  }
  const syncUsage = mock(async () => {})
  internals.usageTracker = { syncUsage }
  internals.makeSdkClient = () => ({ send: mock(async () => makeSdkResponse(events)) })
  internals.prepareSdkRequest = () => cannedPrep()

  const real = new ResponseHandler()
  const lifecycles: SdkResponseLifecycle[] = []
  internals.responseHandler = {
    handleSdkSuccess: async (
      sdkResponse: unknown,
      model: string,
      conversationId: string,
      streaming: boolean,
      lifecycle: SdkResponseLifecycle
    ) => {
      lifecycles.push(lifecycle)
      return real.handleSdkSuccess(sdkResponse, model, conversationId, streaming, lifecycle)
    }
  }
  return { handler, lifecycles, account, syncUsage }
}

describe('RequestHandler → correlation cache publication', () => {
  beforeEach(() => {
    reasoningCorrelationCache.clearAllForTests()
  })

  function inboundBody(messages: unknown[]): string {
    return JSON.stringify({ model: 'claude-opus-5', messages })
  }

  test('a tool-emitting streamed turn publishes under a request-scoped attemptId', async () => {
    const wired = wireHandler(makeAccount('acct-A'), toolLoopEvents(SIG_A))
    const response = await wired.handler.handle(
      KIRO_URL,
      { body: inboundBody([{ role: 'user', content: 'go' }]) },
      noToast
    )
    await drain(response)

    const lifecycle = wired.lifecycles[0]!
    expect(typeof lifecycle.attemptId).toBe('string')
    expect(lifecycle.attemptId!.length).toBeGreaterThan(0)
    expect(lifecycle.effectiveModel).toBe('claude-opus-5')

    const hit = reasoningCorrelationCache.lookup({
      reasoningText: 'step one, then call the tool',
      visibleText: 'calling the tool now',
      toolUses: [{ toolUseId: 'tu-root-1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' }],
      effectiveModel: 'claude-opus-5'
    })
    expect(hit.envelope).toEqual(textEnvelope('step one, then call the tool', SIG_A))
    expect(hit.metadata?.accountId).toBe('acct-A')
    expect(hit.metadata?.loopId).toBe('loop:tu-root-1')
    expect(hit.metadata?.attemptId).toBe(lifecycle.attemptId)
  })

  test('the fingerprint follows emitted reasoning while the envelope preserves signature-covered text', async () => {
    const wired = wireHandler(makeAccount('acct-A'), toolLoopEvents(SIG_A))
    await drain(
      await wired.handler.handle(
        KIRO_URL,
        { body: inboundBody([{ role: 'user', content: 'go' }]) },
        noToast
      )
    )
    const lifecycle = wired.lifecycles[0]
    if (!lifecycle?.onComplete || !lifecycle.attemptId) {
      throw new Error('expected a completed streaming lifecycle')
    }
    reasoningCorrelationCache.clearAllForTests()

    const emitted = new EmittedOutputAccumulator()
    emitted.observeChunk({ choices: [{ delta: { reasoning_content: 'rendered thought' } }] })
    emitted.observeChunk({ choices: [{ delta: { content: 'rendered reply' } }] })
    emitted.observeChunk({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'tu-emitted',
                function: { name: 'read_file', arguments: '{"path":"emitted.ts"}' }
              }
            ]
          }
        }
      ]
    })
    const envelope = textEnvelope('raw signature-covered thought', SIG_B)
    const emittedFingerprint = {
      reasoningText: emitted.reasoningText,
      visibleText: emitted.visibleText,
      toolUses: emitted.toolUses(),
      effectiveModel: 'claude-opus-5'
    }
    const rawEnvelopeFingerprint = {
      ...emittedFingerprint,
      reasoningText: envelope.text
    }
    expect(computeFingerprintKey(emittedFingerprint)).not.toBe(
      computeFingerprintKey(rawEnvelopeFingerprint)
    )

    await lifecycle.onComplete({
      envelope,
      reasoningText: emitted.reasoningText,
      visibleText: emitted.visibleText,
      toolUses: emitted.toolUses(),
      attemptId: lifecycle.attemptId,
      loopId: 'loop:tu-emitted',
      effectiveModel: 'claude-opus-5'
    })

    expect(reasoningCorrelationCache.lookup(emittedFingerprint).envelope).toEqual(envelope)
    expect(reasoningCorrelationCache.lookup(rawEnvelopeFingerprint).refusal).toBe('miss')
  })

  test('the attemptId is unique per SDK send attempt', async () => {
    const first = wireHandler(makeAccount('acct-A'), toolLoopEvents(SIG_A))
    await drain(
      await first.handler.handle(
        KIRO_URL,
        { body: inboundBody([{ role: 'user', content: 'go' }]) },
        noToast
      )
    )
    const second = wireHandler(makeAccount('acct-A'), toolLoopEvents(SIG_A))
    await drain(
      await second.handler.handle(
        KIRO_URL,
        { body: inboundBody([{ role: 'user', content: 'go' }]) },
        noToast
      )
    )
    expect(first.lifecycles[0]!.attemptId).not.toBe(second.lifecycles[0]!.attemptId)
  })

  test('a plain no-tool turn commits success and usage and performs no cache operation', async () => {
    const wired = wireHandler(makeAccount('acct-A'), [
      { reasoningContentEvent: { text: 'brief', signature: SIG_A } },
      { assistantResponseEvent: { content: 'plain answer' } },
      { metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1 } } }
    ])
    await drain(
      await wired.handler.handle(
        KIRO_URL,
        { body: inboundBody([{ role: 'user', content: 'hi' }]) },
        noToast
      )
    )

    expect(wired.lifecycles[0]!.inheritedLoopId).toBeUndefined()
    expect(wired.syncUsage).toHaveBeenCalledTimes(1)
    expect(reasoningCorrelationCache.size).toBe(0)
  })

  test('a final no-tool answer with an inherited loopId tears down only that loop', async () => {
    reasoningCorrelationCache.publish({
      reasoningText: 'earlier thought',
      visibleText: 'earlier reply',
      toolUses: [{ toolUseId: 'root-1', name: 'read', argumentsJson: '{}' }],
      effectiveModel: 'claude-opus-5',
      envelope: textEnvelope('earlier thought', SIG_A),
      loopId: 'loop:root-1',
      accountId: 'acct-A',
      attemptId: 'old-attempt'
    })
    reasoningCorrelationCache.publish({
      reasoningText: 'other loop thought',
      visibleText: 'other loop reply',
      toolUses: [{ toolUseId: 'other-1', name: 'read', argumentsJson: '{}' }],
      effectiveModel: 'claude-opus-5',
      envelope: textEnvelope('other loop thought', SIG_B),
      loopId: 'loop:other-1',
      accountId: 'acct-A',
      attemptId: 'other-attempt'
    })

    const wired = wireHandler(makeAccount('acct-A'), [
      { assistantResponseEvent: { content: 'final answer, no tools' } }
    ])
    await drain(
      await wired.handler.handle(
        KIRO_URL,
        {
          body: inboundBody([
            { role: 'user', content: 'go' },
            { role: 'assistant', tool_calls: [{ id: 'root-1' }] },
            { role: 'tool', tool_call_id: 'root-1', content: 'result' }
          ])
        },
        noToast
      )
    )

    expect(wired.lifecycles[0]!.inheritedLoopId).toBe('loop:root-1')
    expect(reasoningCorrelationCache.sizeForLoop('loop:root-1')).toBe(0)
    expect(reasoningCorrelationCache.sizeForLoop('loop:other-1')).toBe(1)
  })

  test('the non-streaming path leaves the cache empty', async () => {
    const wired = wireHandler(makeAccount('acct-A'), toolLoopEvents(SIG_A))
    ;(wired.handler as any).prepareSdkRequest = () => ({ ...cannedPrep(), streaming: false })
    const response = await wired.handler.handle(
      KIRO_URL,
      { body: inboundBody([{ role: 'user', content: 'go' }]) },
      noToast
    )
    const body = await response.json()

    expect(body.choices[0].message.reasoning_content).toBe('step one, then call the tool')
    expect(reasoningCorrelationCache.size).toBe(0)
  })

  test('a stale attemptId cannot leak an envelope into a later successful attempt', async () => {
    const wired = wireHandler(makeAccount('acct-A'), toolLoopEvents(SIG_A))
    await drain(
      await wired.handler.handle(
        KIRO_URL,
        { body: inboundBody([{ role: 'user', content: 'go' }]) },
        noToast
      )
    )
    const lifecycle = wired.lifecycles[0]!
    const fingerprint = {
      reasoningText: 'superseded thought',
      visibleText: 'superseded reply',
      toolUses: [{ toolUseId: 'tu-stale', name: 'read_file', argumentsJson: '{}' }],
      effectiveModel: 'claude-opus-5'
    }

    await lifecycle.onComplete!({
      envelope: textEnvelope('superseded thought', SIG_B),
      reasoningText: 'superseded thought',
      visibleText: 'superseded reply',
      toolUses: fingerprint.toolUses,
      attemptId: 'a-different-superseded-attempt',
      loopId: 'loop:tu-stale',
      effectiveModel: 'claude-opus-5'
    })

    expect(reasoningCorrelationCache.lookup(fingerprint).refusal).toBe('miss')
  })

  test('a concurrent request on the same account does not invalidate a healthy publication', async () => {
    const shared = makeAccount('acct-shared')
    const slowGate = { release: (): void => {} }
    const gate = new Promise<void>((resolve) => {
      slowGate.release = resolve
    })

    const first = wireHandler(shared, [])
    const firstLifecycles = first.lifecycles
    const firstEvents = toolLoopEvents(SIG_A)
    ;(first.handler as any).makeSdkClient = () => ({
      send: async () => ({
        generateAssistantResponseResponse: (async function* () {
          for (const event of firstEvents) {
            yield event
          }
          await gate
        })()
      })
    })

    const firstPromise = first.handler
      .handle(KIRO_URL, { body: inboundBody([{ role: 'user', content: 'go' }]) }, noToast)
      .then((response) => drain(response))

    const secondEvents = [
      { reasoningContentEvent: { text: 'other thought', signature: SIG_B } },
      { assistantResponseEvent: { content: 'other reply' } },
      { toolUseEvent: { toolUseId: 'tu-other', name: 'read_file', input: '{}', stop: true } }
    ]
    const second = wireHandler(shared, secondEvents)
    await drain(
      await second.handler.handle(
        KIRO_URL,
        { body: inboundBody([{ role: 'user', content: 'other' }]) },
        noToast
      )
    )

    slowGate.release()
    await firstPromise

    expect(firstLifecycles[0]!.attemptId).not.toBe(second.lifecycles[0]!.attemptId)
    const firstHit = reasoningCorrelationCache.lookup({
      reasoningText: 'step one, then call the tool',
      visibleText: 'calling the tool now',
      toolUses: [{ toolUseId: 'tu-root-1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' }],
      effectiveModel: 'claude-opus-5'
    })
    expect(firstHit.envelope).toEqual(textEnvelope('step one, then call the tool', SIG_A))

    const secondHit = reasoningCorrelationCache.lookup({
      reasoningText: 'other thought',
      visibleText: 'other reply',
      toolUses: [{ toolUseId: 'tu-other', name: 'read_file', argumentsJson: '{}' }],
      effectiveModel: 'claude-opus-5'
    })
    expect(secondHit.envelope).toEqual(textEnvelope('other thought', SIG_B))
  })

  test('two concurrent loops publish under different loop ids and stay isolated', async () => {
    const loopAEvents = [
      { reasoningContentEvent: { text: 'loop A thought', signature: SIG_A } },
      { assistantResponseEvent: { content: 'loop A reply' } },
      { toolUseEvent: { toolUseId: 'tu-a', name: 'read_file', input: '{}', stop: true } }
    ]
    const loopBEvents = [
      { reasoningContentEvent: { text: 'loop B thought', signature: SIG_B } },
      { assistantResponseEvent: { content: 'loop B reply' } },
      { toolUseEvent: { toolUseId: 'tu-b', name: 'read_file', input: '{}', stop: true } }
    ]
    const identicalPrompt = [{ role: 'user', content: 'byte-identical opening prompt' }]

    const a = wireHandler(makeAccount('acct-A'), loopAEvents)
    const b = wireHandler(makeAccount('acct-B'), loopBEvents)
    await drain(await a.handler.handle(KIRO_URL, { body: inboundBody(identicalPrompt) }, noToast))
    await drain(await b.handler.handle(KIRO_URL, { body: inboundBody(identicalPrompt) }, noToast))

    expect(reasoningCorrelationCache.sizeForLoop('loop:tu-a')).toBe(1)
    expect(reasoningCorrelationCache.sizeForLoop('loop:tu-b')).toBe(1)

    reasoningCorrelationCache.clearLoop('loop:tu-a')

    expect(
      reasoningCorrelationCache.lookup({
        reasoningText: 'loop A thought',
        visibleText: 'loop A reply',
        toolUses: [{ toolUseId: 'tu-a', name: 'read_file', argumentsJson: '{}' }],
        effectiveModel: 'claude-opus-5'
      }).refusal
    ).toBe('miss')
    expect(
      reasoningCorrelationCache.lookup({
        reasoningText: 'loop B thought',
        visibleText: 'loop B reply',
        toolUses: [{ toolUseId: 'tu-b', name: 'read_file', argumentsJson: '{}' }],
        effectiveModel: 'claude-opus-5'
      }).envelope
    ).toEqual(textEnvelope('loop B thought', SIG_B))
  })

  test('a tool turn with an empty tool id publishes nothing', async () => {
    const wired = wireHandler(makeAccount('acct-A'), [
      { reasoningContentEvent: { text: 'thought', signature: SIG_A } },
      { assistantResponseEvent: { content: 'reply' } },
      { toolUseEvent: { toolUseId: '', name: 'read_file', input: '{}', stop: true } }
    ])
    await drain(
      await wired.handler.handle(
        KIRO_URL,
        { body: inboundBody([{ role: 'user', content: 'go' }]) },
        noToast
      )
    )
    expect(reasoningCorrelationCache.size).toBe(0)
  })

  test('a tool turn with conflicting signatures publishes nothing but keeps the loop alive', async () => {
    reasoningCorrelationCache.publish({
      reasoningText: 'earlier thought',
      visibleText: 'earlier reply',
      toolUses: [{ toolUseId: 'root-1', name: 'read', argumentsJson: '{}' }],
      effectiveModel: 'claude-opus-5',
      envelope: textEnvelope('earlier thought', SIG_A),
      loopId: 'loop:root-1',
      accountId: 'acct-A',
      attemptId: 'old'
    })
    const wired = wireHandler(makeAccount('acct-A'), [
      { reasoningContentEvent: { text: 'thought', signature: SIG_A } },
      { reasoningContentEvent: { signature: SIG_B } },
      { assistantResponseEvent: { content: 'reply' } },
      { toolUseEvent: { toolUseId: 'tu-next', name: 'read_file', input: '{}', stop: true } }
    ])
    await drain(
      await wired.handler.handle(
        KIRO_URL,
        {
          body: inboundBody([
            { role: 'user', content: 'go' },
            { role: 'assistant', tool_calls: [{ id: 'root-1' }] },
            { role: 'tool', tool_call_id: 'root-1', content: 'r' }
          ])
        },
        noToast
      )
    )

    expect(reasoningCorrelationCache.sizeForLoop('loop:root-1')).toBe(1)
  })

  test('a cache miss emits nothing while an exact hit emits nested reasoningContent', () => {
    const requestAuth: KiroAuthDetails = {
      refresh: 'refresh-token',
      access: 'access-token',
      expires: Date.now() + 3_600_000,
      authMethod: 'idc',
      region: 'us-east-1'
    }
    const body = {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'calling the tool now',
          reasoning_content: 'step one, then call the tool',
          tool_calls: [
            {
              id: 'tu-root-1',
              function: { name: 'read_file', arguments: '{ "path": "a.ts" }' }
            }
          ]
        }
      ]
    }

    const miss = transformToSdkRequest(body, 'claude-opus-5', requestAuth)
    expect(JSON.stringify(miss.conversationState)).not.toContain('reasoningContent')

    reasoningCorrelationCache.publish({
      reasoningText: 'step one, then call the tool',
      visibleText: 'calling the tool now',
      toolUses: [{ toolUseId: 'tu-root-1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' }],
      effectiveModel: 'claude-opus-5',
      envelope: textEnvelope('step one, then call the tool', SIG_A),
      loopId: 'loop:tu-root-1',
      accountId: 'acct-A',
      attemptId: 'attempt-A'
    })

    const hit = transformToSdkRequest(body, 'claude-opus-5', requestAuth)
    const serialized = JSON.stringify(hit.conversationState)
    expect(serialized).toContain('reasoningContent')
    expect(serialized).toContain('reasoningText')
    expect(serialized).not.toContain('reasoningSignature')
  })
})
