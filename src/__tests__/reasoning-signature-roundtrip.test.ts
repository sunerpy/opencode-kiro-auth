import { beforeEach, describe, expect, test } from 'bun:test'
import { buildHistory } from '../infrastructure/transformers/history-builder.js'
import { applyThinkingToContent } from '../infrastructure/transformers/message-transformer.js'
import { reasoningCorrelationCache } from '../plugin/reasoning/correlation-cache.js'
import { transformToSdkRequest } from '../plugin/request.js'
import type {
  CodeWhispererMessage,
  KiroAuthDetails,
  KiroReasoningContent
} from '../plugin/types.js'

const MODEL = 'claude-opus-5'
const SIG_A = `sig-${'A'.repeat(320)}`
const SIG_B = `sig-${'B'.repeat(320)}`

const auth: KiroAuthDetails = {
  refresh: 'refresh-token',
  access: 'access-token',
  expires: Date.now() + 3_600_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

type AssistantResponse = NonNullable<CodeWhispererMessage['assistantResponseMessage']>

interface SignedTurnFixture {
  reasoningText: string
  visibleText: string
  signature: string
  toolUseId?: string
  toolName?: string
  argumentsJson?: string
  envelopeText?: string
}

function textEnvelope(
  text: string,
  signature: string
): Extract<KiroReasoningContent, { kind: 'reasoningText' }> {
  return { kind: 'reasoningText', text, signature }
}

function publishSignedTurn(fixture: SignedTurnFixture): void {
  const toolUses = fixture.toolUseId
    ? [
        {
          toolUseId: fixture.toolUseId,
          name: fixture.toolName ?? 'calc',
          argumentsJson: fixture.argumentsJson ?? '{}'
        }
      ]
    : []
  reasoningCorrelationCache.publish({
    reasoningText: fixture.reasoningText,
    visibleText: fixture.visibleText,
    toolUses,
    effectiveModel: MODEL,
    envelope: textEnvelope(fixture.envelopeText ?? fixture.reasoningText, fixture.signature),
    loopId: `loop:${fixture.toolUseId ?? 'fixture'}`,
    accountId: 'account-A',
    attemptId: `attempt:${fixture.toolUseId ?? fixture.visibleText}`
  })
}

function assistantResponses(
  request: ReturnType<typeof transformToSdkRequest>
): AssistantResponse[] {
  return (request.conversationState.history ?? []).flatMap((entry) =>
    entry.assistantResponseMessage ? [entry.assistantResponseMessage] : []
  )
}

function assistantByToolUseId(
  responses: readonly AssistantResponse[],
  toolUseId: string
): AssistantResponse | undefined {
  return responses.find((response) =>
    response.toolUses?.some((toolUse) => toolUse.toolUseId === toolUseId)
  )
}

function toolAssistant(
  turn: number,
  reasoningText: string,
  signature: string
): Record<string, unknown> {
  const toolUseId = `tool-${turn}`
  const toolName = 'calc'
  const argumentsJson = `{"turn":${turn}}`
  const fixture: SignedTurnFixture = {
    reasoningText,
    visibleText: `answer-${turn}`,
    signature,
    toolUseId,
    toolName,
    argumentsJson
  }
  publishSignedTurn(fixture)
  return {
    role: 'assistant',
    content: fixture.visibleText,
    reasoning_content: fixture.reasoningText,
    tool_calls: [
      {
        id: toolUseId,
        function: { name: toolName, arguments: argumentsJson }
      }
    ]
  }
}

beforeEach(() => {
  reasoningCorrelationCache.clearAllForTests()
})

describe('request-side signed reasoning reconstruction', () => {
  test('an exact hit emits only the nested reasoningText wire form', () => {
    publishSignedTurn({
      reasoningText: 'reasoning emitted to OpenCode',
      visibleText: 'visible answer',
      signature: SIG_A,
      envelopeText: 'byte-exact signature-covered reasoning'
    })

    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'question' },
          {
            role: 'assistant',
            content: 'visible answer',
            reasoning_content: 'reasoning emitted to OpenCode'
          }
        ]
      },
      MODEL,
      auth
    )
    const response = assistantResponses(request).at(-1)

    expect(response?.reasoningContent).toEqual({
      reasoningText: {
        text: 'byte-exact signature-covered reasoning',
        signature: SIG_A
      }
    })
    expect(typeof response?.reasoningContent).toBe('object')
    expect(JSON.stringify(response)).not.toContain('reasoningSignature')
  })

  test('native reasoning is mutually exclusive with the thinking-text fallback', () => {
    publishSignedTurn({
      reasoningText: 'private reasoning',
      visibleText: 'original answer',
      signature: SIG_A
    })

    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'question' },
          {
            role: 'assistant',
            content: 'original answer',
            reasoning_content: 'private reasoning'
          }
        ]
      },
      MODEL,
      auth
    )
    const response = assistantResponses(request).at(-1)

    expect(response?.content).toBe('original answer')
    expect(response?.content).not.toContain('<thinking>')
    expect(response?.reasoningContent).toBeDefined()
  })

  test('the thinking-text helper suppresses its wrapper when native reasoning is present', () => {
    expect(applyThinkingToContent('answer', 'reasoning', true)).toBe('answer')
    expect(applyThinkingToContent('answer', 'reasoning', false)).toBe(
      '<thinking>reasoning</thinking>\n\nanswer'
    )
  })

  test('reasoning with no cached signature keeps the existing thinking-text fallback', () => {
    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'question' },
          {
            role: 'assistant',
            content: 'answer',
            reasoning_content: 'unsigned reasoning'
          }
        ]
      },
      MODEL,
      auth
    )
    const response = assistantResponses(request).at(-1)

    expect(response?.reasoningContent).toBeUndefined()
    expect(response?.content).toBe('<thinking>unsigned reasoning</thinking>\n\nanswer')
  })

  test('an empty signature in a cache fixture is refused rather than emitted', () => {
    publishSignedTurn({
      reasoningText: 'reasoning',
      visibleText: 'answer',
      signature: ''
    })

    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'question' },
          { role: 'assistant', content: 'answer', reasoning_content: 'reasoning' }
        ]
      },
      MODEL,
      auth
    )

    expect(assistantResponses(request).at(-1)?.reasoningContent).toBeUndefined()
  })

  test('a redacted cache envelope is not converted into an unsigned reasoning block', () => {
    reasoningCorrelationCache.publish({
      reasoningText: 'reasoning',
      visibleText: 'answer',
      toolUses: [],
      effectiveModel: MODEL,
      envelope: { kind: 'redactedContent', bytes: new Uint8Array([1, 2, 3]) },
      loopId: 'loop:redacted',
      accountId: 'account-A',
      attemptId: 'attempt:redacted'
    })

    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'question' },
          { role: 'assistant', content: 'answer', reasoning_content: 'reasoning' }
        ]
      },
      MODEL,
      auth
    )

    expect(assistantResponses(request).at(-1)?.reasoningContent).toBeUndefined()
  })

  test('a near-miss inbound fingerprint never replays a cached envelope', () => {
    publishSignedTurn({
      reasoningText: 'exact reasoning',
      visibleText: 'exact answer',
      signature: SIG_A
    })

    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'question' },
          {
            role: 'assistant',
            content: 'exact answer.',
            reasoning_content: 'exact reasoning'
          }
        ]
      },
      MODEL,
      auth
    )
    const response = assistantResponses(request).at(-1)

    expect(response?.reasoningContent).toBeUndefined()
    expect(response?.content).toContain('<thinking>exact reasoning</thinking>')
  })
})

describe('request-side merge and collapse safety', () => {
  test('each signed turn keeps its own reasoning through a multi-pair agentic-loop collapse', () => {
    const first = toolAssistant(1, 'reasoning-1', SIG_A)
    const second = toolAssistant(2, 'reasoning-2', SIG_B)
    const third = toolAssistant(3, 'reasoning-3', `${SIG_A}-third`)

    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'run the chain' },
          first,
          { role: 'tool', content: 'result-1', tool_call_id: 'tool-1' },
          second,
          { role: 'tool', content: 'result-2', tool_call_id: 'tool-2' },
          third,
          { role: 'tool', content: 'result-3', tool_call_id: 'tool-3' }
        ]
      },
      MODEL,
      auth
    )
    const responses = assistantResponses(request)
    const firstResponse = assistantByToolUseId(responses, 'tool-1')
    const secondResponse = assistantByToolUseId(responses, 'tool-2')
    const thirdResponse = assistantByToolUseId(responses, 'tool-3')

    expect(firstResponse?.reasoningContent?.reasoningText?.signature).toBe(SIG_A)
    expect(secondResponse?.reasoningContent?.reasoningText?.signature).toBe(SIG_B)
    expect(thirdResponse?.reasoningContent?.reasoningText?.signature).toBe(`${SIG_A}-third`)
    expect(secondResponse?.content).toBe('')
  })

  test('reasoning stays attached to the assistant turn that produced matching tool uses', () => {
    const first = toolAssistant(1, 'first reasoning', SIG_A)
    const second = toolAssistant(2, 'second reasoning', SIG_B)

    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'run' },
          first,
          { role: 'tool', content: 'result-1', tool_call_id: 'tool-1' },
          second,
          { role: 'tool', content: 'result-2', tool_call_id: 'tool-2' }
        ]
      },
      MODEL,
      auth
    )
    const responses = assistantResponses(request)

    expect(assistantByToolUseId(responses, 'tool-1')?.reasoningContent?.reasoningText?.text).toBe(
      'first reasoning'
    )
    expect(assistantByToolUseId(responses, 'tool-2')?.reasoningContent?.reasoningText?.text).toBe(
      'second reasoning'
    )
  })

  test('two adjacent signed source turns produce no reasoning on the pre-history merge path', () => {
    const first = toolAssistant(1, 'reasoning-1', SIG_A)
    const second = toolAssistant(2, 'reasoning-2', SIG_B)

    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'run' },
          first,
          second,
          { role: 'tool', content: 'result-2', tool_call_id: 'tool-2' }
        ]
      },
      MODEL,
      auth
    )

    expect(JSON.stringify(request.conversationState)).not.toContain('reasoningContent')
  })

  test('a signed turn adjacent to an unsigned turn cannot carry its signature across the merge', () => {
    const signed = toolAssistant(1, 'signed reasoning', SIG_A)

    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'run' },
          signed,
          {
            role: 'assistant',
            content: 'unsigned answer',
            tool_calls: [{ id: 'tool-2', function: { name: 'calc', arguments: '{}' } }]
          },
          { role: 'tool', content: 'result-2', tool_call_id: 'tool-2' }
        ]
      },
      MODEL,
      auth
    )

    expect(JSON.stringify(request.conversationState)).not.toContain(SIG_A)
    expect(JSON.stringify(request.conversationState)).not.toContain('reasoningContent')
  })

  test('the buildHistory in-place assistant merge also refuses every source signature', () => {
    const first = toolAssistant(1, 'reasoning-1', SIG_A)
    const second = toolAssistant(2, 'reasoning-2', SIG_B)
    const history = buildHistory(
      [
        { role: 'user', content: 'run' },
        first,
        second,
        { role: 'tool', content: 'result-2', tool_call_id: 'tool-2' }
      ],
      MODEL
    )
    const responses = history.flatMap((entry) =>
      entry.assistantResponseMessage ? [entry.assistantResponseMessage] : []
    )

    expect(responses).toHaveLength(1)
    expect(responses[0]?.reasoningContent).toBeUndefined()
    expect(responses[0]?.content).toContain('<thinking>reasoning-1</thinking>')
    expect(responses[0]?.content).toContain('<thinking>reasoning-2</thinking>')
  })
})

describe('reasoning-signature recovery integration', () => {
  test('disableReasoningReplay strips every block produced by request reconstruction', () => {
    const first = toolAssistant(1, 'reasoning-1', SIG_A)
    const second = toolAssistant(2, 'reasoning-2', SIG_B)
    const body = {
      messages: [
        { role: 'user', content: 'run' },
        first,
        { role: 'tool', content: 'result-1', tool_call_id: 'tool-1' },
        second,
        { role: 'tool', content: 'result-2', tool_call_id: 'tool-2' }
      ]
    }

    const replayed = transformToSdkRequest(body, MODEL, auth)
    const recovered = transformToSdkRequest(body, MODEL, auth, false, 20_000, undefined, {
      disableReasoningReplay: true
    })

    expect(JSON.stringify(replayed.conversationState)).toContain('reasoningContent')
    expect(JSON.stringify(recovered.conversationState)).not.toContain('reasoningContent')
    expect(JSON.stringify(recovered.conversationState)).not.toContain(SIG_A)
    expect(JSON.stringify(recovered.conversationState)).not.toContain(SIG_B)
  })
})
