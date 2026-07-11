import { describe, expect, test } from 'bun:test'
import {
  buildHistory,
  collapseAgenticLoops,
  extractToolNamesFromHistory,
  historyHasToolCalling,
  injectSystemPrompt
} from '../infrastructure/transformers/history-builder.js'
import type { CodeWhispererMessage } from '../plugin/types.js'

const MODEL = 'claude-sonnet-4.5'

describe('buildHistory', () => {
  test('processes all but the final message (the current turn is excluded)', () => {
    const msgs = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'current — excluded' }
    ]
    const history = buildHistory(msgs, MODEL)
    // Only 'first' user + 'reply' assistant appear; 'current' is left for currentMessage
    expect(history).toEqual([
      { userInputMessage: { content: 'first', modelId: MODEL, origin: 'AI_EDITOR' } },
      { assistantResponseMessage: { content: 'reply' } }
    ])
  })

  test('user message with array content extracts text and sets modelId/origin', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'trailing' }
    ]
    const history = buildHistory(msgs, MODEL)
    expect(history[0]).toEqual({
      userInputMessage: { content: 'hello', modelId: MODEL, origin: 'AI_EDITOR' }
    })
  })

  test('assistant tool_use parts become toolUses entries', () => {
    const msgs = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'tu1', name: 'grep', input: { pattern: 'x' } }
        ]
      },
      { role: 'user', content: 'trailing' }
    ]
    const history = buildHistory(msgs, MODEL)
    const asst = history.find((h) => h.assistantResponseMessage)?.assistantResponseMessage
    expect(asst?.content).toBe('let me check')
    expect(asst?.toolUses).toEqual([{ input: { pattern: 'x' }, name: 'grep', toolUseId: 'tu1' }])
  })

  test('assistant OpenAI tool_calls with string arguments are JSON-parsed', () => {
    const msgs = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }]
      },
      { role: 'user', content: 'trailing' }
    ]
    const history = buildHistory(msgs, MODEL)
    const asst = history.find((h) => h.assistantResponseMessage)?.assistantResponseMessage
    expect(asst?.toolUses).toEqual([{ input: { a: 1 }, name: 'f', toolUseId: 'c1' }])
  })

  test('assistant thinking part is wrapped in <thinking> tags before content', () => {
    const msgs = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'answer' }
        ]
      },
      { role: 'user', content: 'trailing' }
    ]
    const history = buildHistory(msgs, MODEL)
    const asst = history.find((h) => h.assistantResponseMessage)?.assistantResponseMessage
    expect(asst?.content).toBe('<thinking>hmm</thinking>\n\nanswer')
  })

  test('tool role message builds a synthetic user turn with toolResults', () => {
    const msgs = [
      { role: 'assistant', content: 'call', tool_calls: [{ id: 't1', function: { name: 'f' } }] },
      { role: 'tool', content: 'result-text', tool_call_id: 't1' },
      { role: 'user', content: 'trailing' }
    ]
    const history = buildHistory(msgs, MODEL)
    const toolTurn = history.find(
      (h) => h.userInputMessage?.userInputMessageContext?.toolResults
    )?.userInputMessage
    expect(toolTurn?.content).toBe('Tool results provided.')
    expect(toolTurn?.userInputMessageContext?.toolResults).toEqual([
      { content: [{ text: 'result-text' }], status: 'success', toolUseId: 't1' }
    ])
  })

  test('empty assistant message (no content, no tools) is skipped', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'trailing' }
    ]
    const history = buildHistory(msgs, MODEL)
    expect(history.some((h) => h.assistantResponseMessage)).toBe(false)
  })

  test('consecutive user turns get a synthetic assistant separator injected', () => {
    const msgs = [
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2' },
      { role: 'user', content: 'trailing' }
    ]
    // mergeAdjacentMessages is NOT applied inside buildHistory, so two user turns
    // in a row trigger the [system: conversation continues] separator.
    const history = buildHistory(msgs, MODEL)
    expect(history).toEqual([
      { userInputMessage: { content: 'u1', modelId: MODEL, origin: 'AI_EDITOR' } },
      { assistantResponseMessage: { content: '[system: conversation continues]' } },
      { userInputMessage: { content: 'u2', modelId: MODEL, origin: 'AI_EDITOR' } }
    ])
  })
})

describe('collapseAgenticLoops', () => {
  test('history shorter than 4 entries is returned unchanged', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'a', modelId: MODEL, origin: 'AI_EDITOR' } },
      { assistantResponseMessage: { content: 'b' } }
    ]
    expect(collapseAgenticLoops(history)).toBe(history)
  })

  test('collapses intermediate assistant text across a multi-pair tool loop', () => {
    const mkPair = (n: number): CodeWhispererMessage[] => [
      {
        assistantResponseMessage: {
          content: `preamble ${n}`,
          toolUses: [{ input: {}, name: 'tool', toolUseId: `u${n}` }]
        }
      },
      {
        userInputMessage: {
          content: 'Tool results provided.',
          modelId: MODEL,
          origin: 'AI_EDITOR',
          userInputMessageContext: {
            toolResults: [{ toolUseId: `u${n}`, content: [{ text: 'ok' }], status: 'success' }]
          }
        }
      }
    ]
    const history = [...mkPair(1), ...mkPair(2)]
    const result = collapseAgenticLoops(history)
    // First pair keeps its original assistant text; subsequent pair's text is replaced.
    expect(result[0]?.assistantResponseMessage?.content).toBe('preamble 1')
    expect(result[2]?.assistantResponseMessage?.content).toBe('[system: tool calling continues]')
    // toolUses are preserved through the collapse.
    expect(result[2]?.assistantResponseMessage?.toolUses?.[0]?.toolUseId).toBe('u2')
  })
})

describe('injectSystemPrompt', () => {
  test('prepends system text to the first user message content', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'hello', modelId: MODEL, origin: 'AI_EDITOR' } }
    ]
    const result = injectSystemPrompt(history, 'SYSTEM', MODEL)
    expect(result[0]?.userInputMessage?.content).toBe('SYSTEM\n\nhello')
  })

  test('undefined system returns history unchanged', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'x', modelId: MODEL, origin: 'AI_EDITOR' } }
    ]
    expect(injectSystemPrompt(history, undefined, MODEL)).toBe(history)
  })

  test('no user message present -> unshifts a synthetic system user turn', () => {
    const history: CodeWhispererMessage[] = [{ assistantResponseMessage: { content: 'only' } }]
    const result = injectSystemPrompt(history, 'SYS', MODEL)
    expect(result[0]).toEqual({
      userInputMessage: { content: 'SYS', modelId: MODEL, origin: 'AI_EDITOR' }
    })
  })
})

describe('historyHasToolCalling', () => {
  test('true when an assistant turn has toolUses', () => {
    expect(
      historyHasToolCalling([
        {
          assistantResponseMessage: {
            content: '',
            toolUses: [{ input: {}, name: 't', toolUseId: 'u' }]
          }
        }
      ])
    ).toBe(true)
  })

  test('true when a user turn has toolResults', () => {
    expect(
      historyHasToolCalling([
        {
          userInputMessage: {
            content: 'x',
            modelId: MODEL,
            origin: 'AI_EDITOR',
            userInputMessageContext: {
              toolResults: [{ toolUseId: 'u', content: [{ text: 'r' }], status: 'success' }]
            }
          }
        }
      ])
    ).toBe(true)
  })

  test('false for plain text-only history', () => {
    expect(
      historyHasToolCalling([
        { userInputMessage: { content: 'x', modelId: MODEL, origin: 'AI_EDITOR' } },
        { assistantResponseMessage: { content: 'y' } }
      ])
    ).toBe(false)
  })
})

describe('extractToolNamesFromHistory', () => {
  test('collects unique tool names from all assistant toolUses', () => {
    const history: CodeWhispererMessage[] = [
      {
        assistantResponseMessage: {
          content: '',
          toolUses: [
            { input: {}, name: 'read', toolUseId: 'a' },
            { input: {}, name: 'grep', toolUseId: 'b' }
          ]
        }
      },
      {
        assistantResponseMessage: {
          content: '',
          toolUses: [{ input: {}, name: 'read', toolUseId: 'c' }]
        }
      }
    ]
    const names = extractToolNamesFromHistory(history)
    expect(names).toEqual(new Set(['read', 'grep']))
  })

  test('empty set when no tool uses present', () => {
    expect(extractToolNamesFromHistory([{ assistantResponseMessage: { content: 'hi' } }])).toEqual(
      new Set()
    )
  })
})
