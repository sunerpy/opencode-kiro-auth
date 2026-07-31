import { describe, expect, test } from 'bun:test'
import { buildHistory } from '../infrastructure/transformers/history-builder.js'
import { transformToSdkRequest } from '../plugin/request.js'
import type { CodeWhispererMessage, KiroAuthDetails } from '../plugin/types.js'

const MODEL = 'claude-sonnet-4-5'
const CONVERSATION_MARKER = '[system: conversation continues]'

const auth: KiroAuthDetails = {
  refresh: 'r',
  access: 'access-token',
  expires: Date.now() + 3_600_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

type TurnKind = 'assistant' | 'user'

function turnKind(entry: CodeWhispererMessage): TurnKind {
  return entry.assistantResponseMessage ? 'assistant' : 'user'
}

function alternationViolations(history: CodeWhispererMessage[]): string[] {
  const violations: string[] = []
  for (let i = 1; i < history.length; i++) {
    const previous = history[i - 1]
    const current = history[i]
    if (!previous || !current) continue
    const kind = turnKind(current)
    if (turnKind(previous) === kind) violations.push(`${i - 1}->${i} both ${kind}`)
  }
  return violations
}

function separatorTurnCount(history: CodeWhispererMessage[]): number {
  return history.filter((entry) => {
    const assistant = entry.assistantResponseMessage
    return !!assistant && !assistant.content && !assistant.toolUses && !assistant.reasoningContent
  }).length
}

function assistantContents(state: {
  currentMessage: CodeWhispererMessage
  history?: CodeWhispererMessage[]
}): string[] {
  return [...(state.history ?? []), state.currentMessage].flatMap((entry) =>
    entry.assistantResponseMessage ? [entry.assistantResponseMessage.content] : []
  )
}

function toolChainMsgs(pairs: number): any[] {
  const msgs: any[] = [{ role: 'user', content: 'run the whole chain' }]
  for (let turn = 1; turn <= pairs; turn++) {
    msgs.push({
      role: 'assistant',
      content: `step ${turn}`,
      tool_calls: [{ id: `tu${turn}`, function: { name: 'calc', arguments: `{"n":${turn}}` } }]
    })
    msgs.push({ role: 'tool', content: `result ${turn}`, tool_call_id: `tu${turn}` })
  }
  return msgs
}

describe('buildHistory alternation invariant', () => {
  const shapes: Array<{ label: string; msgs: any[] }> = [
    {
      label: 'user -> user',
      msgs: [
        { role: 'user', content: 'u1' },
        { role: 'user', content: 'u2' },
        { role: 'user', content: 'trailing' }
      ]
    },
    {
      label: 'user -> tool',
      msgs: [
        { role: 'assistant', content: 'call', tool_calls: [{ id: 't1', function: { name: 'f' } }] },
        { role: 'user', content: 'meanwhile, also do this' },
        { role: 'tool', content: 'result', tool_call_id: 't1' },
        { role: 'user', content: 'trailing' }
      ]
    },
    {
      label: 'tool -> user',
      msgs: [
        { role: 'assistant', content: 'call', tool_calls: [{ id: 't1', function: { name: 'f' } }] },
        { role: 'tool', content: 'result', tool_call_id: 't1' },
        { role: 'user', content: 'now summarize' },
        { role: 'user', content: 'trailing' }
      ]
    },
    {
      label: 'tool -> tool',
      msgs: [
        {
          role: 'assistant',
          content: 'call two',
          tool_calls: [
            { id: 't1', function: { name: 'f' } },
            { id: 't2', function: { name: 'g' } }
          ]
        },
        { role: 'tool', content: 'first', tool_call_id: 't1' },
        { role: 'tool', content: 'second', tool_call_id: 't2' },
        { role: 'user', content: 'trailing' }
      ]
    },
    {
      label: 'assistant -> assistant',
      msgs: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'part one' },
        { role: 'assistant', content: 'part two' },
        { role: 'user', content: 'trailing' }
      ]
    },
    {
      label: 'long tool chain (6 pairs)',
      msgs: [...toolChainMsgs(6), { role: 'user', content: 'x' }]
    }
  ]

  for (const shape of shapes) {
    test(`${shape.label}: no two consecutive entries share a kind`, () => {
      expect(alternationViolations(buildHistory(shape.msgs, MODEL))).toEqual([])
    })

    test(`${shape.label}: no synthesized assistant separator is emitted`, () => {
      expect(separatorTurnCount(buildHistory(shape.msgs, MODEL))).toBe(0)
    })
  }
})

describe('merging preserves content and tool results', () => {
  test('a user turn followed by a tool turn keeps both texts and both tool results', () => {
    const history = buildHistory(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'read it' },
            { type: 'tool_result', tool_use_id: 'tu1', content: 'from the user turn' }
          ]
        },
        { role: 'tool', content: 'from the tool turn', tool_call_id: 'tu2' },
        { role: 'user', content: 'trailing' }
      ],
      MODEL
    )

    expect(history).toHaveLength(1)
    const merged = history[0]?.userInputMessage
    expect(merged?.content).toBe('read it')
    expect(merged?.userInputMessageContext?.toolResults).toEqual([
      { content: [{ text: 'from the user turn' }], status: 'success', toolUseId: 'tu1' },
      { content: [{ text: 'from the tool turn' }], status: 'success', toolUseId: 'tu2' }
    ])
  })

  test('a tool turn followed by a user turn keeps the later text and the earlier results', () => {
    const history = buildHistory(
      [
        { role: 'assistant', content: 'call', tool_calls: [{ id: 't1', function: { name: 'f' } }] },
        { role: 'tool', content: 'tool output', tool_call_id: 't1' },
        { role: 'user', content: 'now summarize' },
        { role: 'user', content: 'trailing' }
      ],
      MODEL
    )

    const merged = history[history.length - 1]?.userInputMessage
    expect(merged?.content).toBe('now summarize')
    expect(merged?.userInputMessageContext?.toolResults).toEqual([
      { content: [{ text: 'tool output' }], status: 'success', toolUseId: 't1' }
    ])
  })

  test('duplicate toolUseIds across the merged sides are deduplicated', () => {
    const history = buildHistory(
      [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'dup', content: 'winner' }]
        },
        { role: 'tool', content: 'loser', tool_call_id: 'dup' },
        { role: 'user', content: 'trailing' }
      ],
      MODEL
    )

    expect(history[0]?.userInputMessage?.userInputMessageContext?.toolResults).toEqual([
      { content: [{ text: 'winner' }], status: 'success', toolUseId: 'dup' }
    ])
  })

  test('the surviving entry keeps its own modelId and origin', () => {
    const history = buildHistory(
      [
        { role: 'user', content: 'u1' },
        { role: 'user', content: 'u2' },
        { role: 'user', content: 'trailing' }
      ],
      MODEL
    )

    expect(history[0]?.userInputMessage?.modelId).toBe(MODEL)
    expect(history[0]?.userInputMessage?.origin).toBe('AI_EDITOR')
  })

  test('merged images are capped at the per-turn API limit and the drop is recorded', () => {
    const imagePart = (n: number) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: `img${n}` }
    })
    const history = buildHistory(
      [
        {
          role: 'user',
          content: [{ type: 'text', text: 'batch one' }, ...[1, 2, 3].map(imagePart)]
        },
        { role: 'user', content: [{ type: 'text', text: 'batch two' }, ...[4, 5].map(imagePart)] },
        { role: 'user', content: 'trailing' }
      ],
      MODEL
    )

    const merged = history[0]?.userInputMessage
    expect(merged?.images).toHaveLength(4)
    expect(merged?.content).toContain('batch one')
    expect(merged?.content).toContain('batch two')
    expect(merged?.content).toContain('1 image(s) omitted due to API limits')
  })
})

describe('no assistant turn carries a synthesized conversation marker', () => {
  const shapes: Array<{ label: string; body: any }> = [
    {
      label: 'first turn with a system prompt',
      body: { system: 'SYS', messages: [{ role: 'user', content: 'hi' }] }
    },
    {
      label: 'user turn after a tool loop',
      body: { messages: [...toolChainMsgs(2), { role: 'user', content: 'now summarize' }] }
    },
    { label: 'tool turn closing a 5-pair chain', body: { messages: toolChainMsgs(5) } },
    {
      label: 'user text interleaved with tool results',
      body: {
        messages: [
          {
            role: 'assistant',
            content: 'call',
            tool_calls: [{ id: 't1', function: { name: 'f' } }]
          },
          { role: 'user', content: 'extra instruction' },
          { role: 'tool', content: 'result', tool_call_id: 't1' },
          { role: 'user', content: 'wrap up' }
        ]
      }
    }
  ]

  for (const shape of shapes) {
    test(`${shape.label}: every assistant turn is marker-free`, () => {
      const state = transformToSdkRequest(shape.body, MODEL, auth).conversationState
      for (const content of assistantContents(state)) {
        expect(content).not.toContain('conversation continues')
      }
    })

    test(`${shape.label}: history alternates strictly`, () => {
      const state = transformToSdkRequest(shape.body, MODEL, auth).conversationState
      expect(alternationViolations(state.history ?? [])).toEqual([])
    })
  }

  test('a 6-pair tool chain needs no synthesized assistant separator at all', () => {
    const state = transformToSdkRequest(
      { messages: toolChainMsgs(6) },
      MODEL,
      auth
    ).conversationState
    expect(separatorTurnCount(state.history ?? [])).toBe(0)
  })

  test('the marker survives only where it belongs: the currentMessage user turn', () => {
    const assistantFinal = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'partial answer' }
        ]
      },
      MODEL,
      auth
    ).conversationState
    expect(assistantFinal.currentMessage.userInputMessage?.content).toBe(CONVERSATION_MARKER)
    for (const content of assistantContents(assistantFinal)) {
      expect(content).not.toContain('conversation continues')
    }

    const emptyUserFinal = transformToSdkRequest(
      { messages: [{ role: 'user', content: '' }] },
      MODEL,
      auth
    ).conversationState
    expect(emptyUserFinal.currentMessage.userInputMessage?.content).toBe(CONVERSATION_MARKER)
    for (const content of assistantContents(emptyUserFinal)) {
      expect(content).not.toContain('conversation continues')
    }
  })
})
