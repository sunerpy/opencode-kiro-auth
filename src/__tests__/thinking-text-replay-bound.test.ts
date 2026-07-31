import { beforeEach, describe, expect, test } from 'bun:test'
import {
  findActiveToolLoopStart,
  findThinkingTextReplayIndex
} from '../infrastructure/transformers/message-transformer.js'
import { reasoningCorrelationCache } from '../plugin/reasoning/correlation-cache.js'
import { transformToSdkRequest } from '../plugin/request.js'
import type { CodeWhispererMessage, KiroAuthDetails } from '../plugin/types.js'

const MODEL = 'claude-opus-5'
const SIGNATURE_PREFIX = `sig-${'S'.repeat(320)}`

const auth: KiroAuthDetails = {
  refresh: 'refresh-token',
  access: 'access-token',
  expires: Date.now() + 3_600_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

type AssistantResponse = NonNullable<CodeWhispererMessage['assistantResponseMessage']>

function missTurn(turn: number): Record<string, unknown> {
  return {
    role: 'assistant',
    content: `visible-${turn}`,
    reasoning_content: `thought-${turn}`,
    tool_calls: [{ id: `tu-${turn}`, function: { name: 'calc', arguments: `{"turn":${turn}}` } }]
  }
}

function hitTurn(turn: number): Record<string, unknown> {
  const message = missTurn(turn)
  reasoningCorrelationCache.publish({
    reasoningText: `thought-${turn}`,
    visibleText: `visible-${turn}`,
    toolUses: [{ toolUseId: `tu-${turn}`, name: 'calc', argumentsJson: `{"turn":${turn}}` }],
    effectiveModel: MODEL,
    envelope: {
      kind: 'reasoningText',
      text: `thought-${turn}`,
      signature: `${SIGNATURE_PREFIX}-${turn}`
    },
    loopId: `loop:tu-${turn}`,
    accountId: 'account-A',
    attemptId: `attempt:tu-${turn}`
  })
  return message
}

function toolLoop(
  turns: number,
  makeTurn: (turn: number) => Record<string, unknown>
): Record<string, unknown>[] {
  const msgs: Record<string, unknown>[] = [{ role: 'user', content: 'run the chain' }]
  for (let turn = 1; turn <= turns; turn++) {
    msgs.push(makeTurn(turn))
    msgs.push({ role: 'tool', content: `result-${turn}`, tool_call_id: `tu-${turn}` })
  }
  return msgs
}

function buildRequest(
  messages: Record<string, unknown>[]
): ReturnType<typeof transformToSdkRequest> {
  return transformToSdkRequest({ messages }, MODEL, auth)
}

function assistantResponses(
  request: ReturnType<typeof transformToSdkRequest>
): AssistantResponse[] {
  return (request.conversationState.history ?? []).flatMap((entry) =>
    entry.assistantResponseMessage ? [entry.assistantResponseMessage] : []
  )
}

function countThinkingBlocks(request: ReturnType<typeof transformToSdkRequest>): number {
  return (JSON.stringify(request).match(/<thinking>/g) ?? []).length
}

beforeEach(() => {
  reasoningCorrelationCache.clearAllForTests()
})

describe('findThinkingTextReplayIndex', () => {
  test('selects the latest assistant turn, which sits inside the active tool loop', () => {
    const msgs = toolLoop(3, missTurn)
    const index = findThinkingTextReplayIndex(msgs)

    expect(msgs[index]).toBe(msgs.at(-2))
    expect(index).toBeGreaterThanOrEqual(findActiveToolLoopStart(msgs))
  })

  test('a conversation without an assistant turn selects nothing', () => {
    expect(findThinkingTextReplayIndex([{ role: 'user', content: 'q' }])).toBe(-1)
  })
})

describe('signature-miss <thinking> replay is bounded to one turn', () => {
  test('several miss turns in one active loop leave only the latest turn thinking', () => {
    const request = buildRequest(toolLoop(3, missTurn))

    expect(countThinkingBlocks(request)).toBe(1)
    expect(JSON.stringify(request)).toContain('<thinking>thought-3</thinking>')
  })

  test('earlier miss turns keep their visible content and tool uses', () => {
    const responses = assistantResponses(buildRequest(toolLoop(2, missTurn)))
    const earlier = responses[0]

    expect(earlier?.content).toBe('visible-1')
    expect(earlier?.toolUses).toEqual([{ input: { turn: 1 }, name: 'calc', toolUseId: 'tu-1' }])
    expect(responses.at(-1)?.content).toBe('<thinking>thought-2</thinking>\n\nvisible-2')
  })

  test('six collapsible miss pairs still produce exactly one thinking block', () => {
    const request = buildRequest(toolLoop(6, missTurn))

    expect(countThinkingBlocks(request)).toBe(1)
    expect(JSON.stringify(request)).toContain('<thinking>thought-6</thinking>')
  })

  test('a single assistant turn still replays its thinking text', () => {
    const request = buildRequest(toolLoop(1, missTurn))

    expect(countThinkingBlocks(request)).toBe(1)
    expect(JSON.stringify(request)).toContain('<thinking>thought-1</thinking>')
  })
})

describe('signature hits are untouched by the thinking-text bound', () => {
  test('every hit turn replays native reasoningContent and no thinking text', () => {
    const request = buildRequest(toolLoop(3, hitTurn))
    const signatures = assistantResponses(request).flatMap((response) =>
      response.reasoningContent?.reasoningText?.signature
        ? [response.reasoningContent.reasoningText.signature]
        : []
    )

    expect(signatures).toEqual([
      `${SIGNATURE_PREFIX}-1`,
      `${SIGNATURE_PREFIX}-2`,
      `${SIGNATURE_PREFIX}-3`
    ])
    expect(countThinkingBlocks(request)).toBe(0)
  })

  test('a hit on the latest turn suppresses the text fallback it would otherwise get', () => {
    const msgs = toolLoop(2, missTurn)
    msgs[msgs.length - 2] = hitTurn(2)
    const request = buildRequest(msgs)

    expect(countThinkingBlocks(request)).toBe(0)
    expect(assistantResponses(request).at(-1)?.reasoningContent?.reasoningText?.signature).toBe(
      `${SIGNATURE_PREFIX}-2`
    )
  })
})
