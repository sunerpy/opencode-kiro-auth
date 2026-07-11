import { describe, expect, test } from 'bun:test'
import {
  findOriginalToolCall,
  getContentText,
  mergeAdjacentMessages,
  sanitizeHistory
} from '../infrastructure/transformers/message-transformer.js'

describe('getContentText', () => {
  test('null/undefined -> empty string', () => {
    expect(getContentText(null)).toBe('')
    expect(getContentText(undefined)).toBe('')
  })

  test('plain string arg -> itself', () => {
    expect(getContentText('hello')).toBe('hello')
  })

  test('message with string content -> content', () => {
    expect(getContentText({ role: 'user', content: 'hi there' })).toBe('hi there')
  })

  test('message with array content -> joins only text parts', () => {
    const m = {
      content: [
        { type: 'text', text: 'foo' },
        { type: 'image', source: {} },
        { type: 'text', text: 'bar' }
      ]
    }
    expect(getContentText(m)).toBe('foobar')
  })

  test('array content with missing text fields -> empty joins', () => {
    const m = { content: [{ type: 'text' }, { type: 'text', text: 'x' }] }
    expect(getContentText(m)).toBe('x')
  })

  test('object with only text field (no content) -> text', () => {
    expect(getContentText({ text: 'raw-text' })).toBe('raw-text')
  })
})

describe('mergeAdjacentMessages', () => {
  test('merges two adjacent user string messages with newline', () => {
    const merged = mergeAdjacentMessages([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' }
    ])
    expect(merged).toEqual([{ role: 'user', content: 'a\nb' }])
  })

  test('does not merge across differing roles', () => {
    const msgs = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'r' }
    ]
    expect(mergeAdjacentMessages(msgs)).toEqual(msgs)
  })

  test('merges two array-content messages by concatenating parts', () => {
    const merged = mergeAdjacentMessages([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] }
    ])
    expect(merged).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' }
        ]
      }
    ])
  })

  test('array + string: string appended as a text part', () => {
    const merged = mergeAdjacentMessages([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: 'b' }
    ])
    expect(merged).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' }
        ]
      }
    ])
  })

  test('string + array: string becomes leading text part', () => {
    const merged = mergeAdjacentMessages([
      { role: 'user', content: 'a' },
      { role: 'user', content: [{ type: 'text', text: 'b' }] }
    ])
    expect(merged).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' }
        ]
      }
    ])
  })

  test('merges assistant tool_calls arrays', () => {
    const merged = mergeAdjacentMessages([
      { role: 'assistant', content: 'x', tool_calls: [{ id: '1' }] },
      { role: 'assistant', content: 'y', tool_calls: [{ id: '2' }] }
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].tool_calls).toEqual([{ id: '1' }, { id: '2' }])
    expect(merged[0].content).toBe('x\ny')
  })

  test('merges adjacent tool messages into tool_results array', () => {
    const merged = mergeAdjacentMessages([
      { role: 'tool', content: 'r1', tool_call_id: 'c1' },
      { role: 'tool', content: 'r2', tool_call_id: 'c2' }
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].tool_results).toEqual([
      { content: 'r1\nr2', tool_call_id: 'c1' },
      { content: 'r2', tool_call_id: 'c2' }
    ])
  })

  test('single message passes through as a shallow copy', () => {
    const input = [{ role: 'user', content: 'solo' }]
    const merged = mergeAdjacentMessages(input)
    expect(merged).toEqual(input)
    expect(merged[0]).not.toBe(input[0])
  })
})

describe('findOriginalToolCall', () => {
  test('finds OpenAI tool_call by id', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'f' } }] }
    ]
    expect(findOriginalToolCall(msgs, 'call_1')).toEqual({
      id: 'call_1',
      function: { name: 'f' }
    })
  })

  test('finds Anthropic tool_use part in assistant array content', () => {
    const msgs = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_9', name: 'g', input: { a: 1 } }]
      }
    ]
    expect(findOriginalToolCall(msgs, 'tu_9')).toEqual({
      type: 'tool_use',
      id: 'tu_9',
      name: 'g',
      input: { a: 1 }
    })
  })

  test('returns null when id is not present', () => {
    const msgs = [{ role: 'assistant', tool_calls: [{ id: 'other' }] }]
    expect(findOriginalToolCall(msgs, 'missing')).toBeNull()
  })

  test('ignores non-assistant roles', () => {
    const msgs = [{ role: 'user', tool_calls: [{ id: 'x' }] }]
    expect(findOriginalToolCall(msgs, 'x')).toBeNull()
  })
})

describe('sanitizeHistory', () => {
  test('drops leading assistant messages until first plain user', () => {
    const history = [
      { assistantResponseMessage: { content: 'orphan' } },
      { userInputMessage: { content: 'real', modelId: 'm', origin: 'AI_EDITOR' } },
      { assistantResponseMessage: { content: 'reply' } }
    ]
    const result = sanitizeHistory(history)
    // trailing assistant is popped, leading assistant dropped -> only the user turn remains
    expect(result).toEqual([
      { userInputMessage: { content: 'real', modelId: 'm', origin: 'AI_EDITOR' } }
    ])
  })

  test('keeps a valid tool_use/tool_result pair', () => {
    const history = [
      { userInputMessage: { content: 'q', modelId: 'm', origin: 'AI_EDITOR' } },
      {
        assistantResponseMessage: {
          content: 'calling',
          toolUses: [{ input: {}, name: 't', toolUseId: 'u1' }]
        }
      },
      {
        userInputMessage: {
          content: 'Tool results provided.',
          modelId: 'm',
          origin: 'AI_EDITOR',
          userInputMessageContext: {
            toolResults: [{ toolUseId: 'u1', content: [{ text: 'ok' }], status: 'success' }]
          }
        }
      }
    ]
    const result = sanitizeHistory(history)
    expect(result).toHaveLength(3)
    expect(result[0]?.userInputMessage?.content).toBe('q')
    expect(result[1]?.assistantResponseMessage?.toolUses?.[0]?.toolUseId).toBe('u1')
    expect(result[2]?.userInputMessage?.userInputMessageContext?.toolResults?.[0]?.toolUseId).toBe(
      'u1'
    )
  })

  test('drops an assistant toolUses with no matching following toolResults', () => {
    const history = [
      { userInputMessage: { content: 'q', modelId: 'm', origin: 'AI_EDITOR' } },
      {
        assistantResponseMessage: {
          content: 'calling',
          toolUses: [{ input: {}, name: 't', toolUseId: 'u1' }]
        }
      },
      { userInputMessage: { content: 'unrelated', modelId: 'm', origin: 'AI_EDITOR' } }
    ]
    const result = sanitizeHistory(history)
    // the orphan assistant-with-toolUses is dropped; the two user turns survive
    expect(result.every((m) => !m.assistantResponseMessage)).toBe(true)
    expect(result.map((m) => m.userInputMessage?.content)).toEqual(['q', 'unrelated'])
  })

  test('empty result when nothing survives filtering', () => {
    const history = [{ assistantResponseMessage: { content: 'only-assistant' } }]
    expect(sanitizeHistory(history)).toEqual([])
  })
})
