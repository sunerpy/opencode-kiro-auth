import { describe, expect, test } from 'bun:test'
import { buildHistory } from '../infrastructure/transformers/history-builder.js'
import {
  extractReasoningText,
  findActiveToolLoopStart,
  parseAssistantMessage
} from '../infrastructure/transformers/message-transformer.js'
import { transformToSdkRequest } from '../plugin/request.js'
import type { KiroAuthDetails } from '../plugin/types.js'

const MODEL = 'claude-sonnet-4.5'

const auth: KiroAuthDetails = {
  refresh: 'r',
  access: 'access-token',
  expires: Date.now() + 3_600_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

function asstEntries(history: ReturnType<typeof buildHistory>) {
  return history.flatMap((h) => (h.assistantResponseMessage ? [h.assistantResponseMessage] : []))
}

function toolLoopMsgs(reasoningPerTurn: Array<string | undefined>) {
  const msgs: any[] = [{ role: 'user', content: 'do the chain' }]
  reasoningPerTurn.forEach((rc, idx) => {
    const turn = idx + 1
    const asst: any = {
      role: 'assistant',
      content: `step ${turn}`,
      tool_calls: [{ id: `tu${turn}`, function: { name: 'calc', arguments: `{"n":${turn}}` } }]
    }
    if (rc !== undefined) asst.reasoning_content = rc
    msgs.push(asst)
    msgs.push({ role: 'tool', content: `result ${turn}`, tool_call_id: `tu${turn}` })
  })
  return msgs
}

describe('extractReasoningText', () => {
  test('reads a top-level reasoning_content string', () => {
    expect(extractReasoningText({ role: 'assistant', reasoning_content: 'why' })).toBe('why')
  })

  test('joins array-shaped reasoning_content parts', () => {
    expect(
      extractReasoningText({
        reasoning_content: ['a', { text: 'b' }, { thinking: 'c' }, { other: 1 }]
      })
    ).toBe('abc')
  })

  test('missing or non-string reasoning_content -> empty string', () => {
    expect(extractReasoningText({ role: 'assistant', content: 'x' })).toBe('')
    expect(extractReasoningText({ reasoning_content: 42 })).toBe('')
    expect(extractReasoningText(undefined)).toBe('')
  })
})

describe('parseAssistantMessage', () => {
  test('string content + reasoning_content is recovered when enabled', () => {
    const parsed = parseAssistantMessage(
      { role: 'assistant', content: 'answer', reasoning_content: 'because' },
      { recoverReasoning: true }
    )
    expect(parsed.content).toBe('answer')
    expect(parsed.thinking).toBe('because')
  })

  test('reasoning_content is ignored when recovery is disabled', () => {
    const parsed = parseAssistantMessage({
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'because'
    })
    expect(parsed.thinking).toBe('')
  })

  test('array thinking parts win over top-level reasoning_content', () => {
    const parsed = parseAssistantMessage(
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'array-thought' },
          { type: 'text', text: 'answer' }
        ],
        reasoning_content: 'top-level-thought'
      },
      { recoverReasoning: true }
    )
    expect(parsed.thinking).toBe('array-thought')
    expect(parsed.content).toBe('answer')
  })

  test('tool_calls and tool_use parts both land in toolUses', () => {
    const parsed = parseAssistantMessage({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'a1', name: 'grep', input: { p: 'x' } }],
      tool_calls: [{ id: 'b1', function: { name: 'calc', arguments: '{"n":1}' } }]
    })
    expect(parsed.toolUses).toEqual([
      { input: { p: 'x' }, name: 'grep', toolUseId: 'a1' },
      { input: { n: 1 }, name: 'calc', toolUseId: 'b1' }
    ])
  })
})

describe('findActiveToolLoopStart', () => {
  test('conversation not ending in a tool loop -> msgs.length', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' }
    ]
    expect(findActiveToolLoopStart(msgs)).toBe(msgs.length)
  })

  test('trailing assistant(tool_calls) -> tool run is the loop', () => {
    const msgs = toolLoopMsgs(['r1', 'r2'])
    // [user, asst1, tool1, asst2, tool2] -> loop starts at asst1 (index 1)
    expect(findActiveToolLoopStart(msgs)).toBe(1)
  })

  test('an older completed loop before a plain turn is excluded', () => {
    const msgs = [
      ...toolLoopMsgs(['old']),
      { role: 'assistant', content: 'final answer' },
      { role: 'user', content: 'new question' },
      {
        role: 'assistant',
        content: 'step',
        reasoning_content: 'new',
        tool_calls: [{ id: 'tuN', function: { name: 'calc', arguments: '{}' } }]
      },
      { role: 'tool', content: 'res', tool_call_id: 'tuN' }
    ]
    expect(findActiveToolLoopStart(msgs)).toBe(msgs.length - 2)
  })

  test('array-shaped user tool_result messages count as loop members', () => {
    const msgs = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'calc', input: {} }]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'r' }] }
    ]
    expect(findActiveToolLoopStart(msgs)).toBe(1)
  })
})

describe('buildHistory — reasoning_content recovery', () => {
  test('reasoning_content becomes <thinking> content on the loop-latest turn only', () => {
    const msgs = toolLoopMsgs(['thought one', 'thought two'])
    const history = buildHistory(msgs, MODEL)
    const asst = asstEntries(history)
    expect(asst.at(-1)?.content).toBe('<thinking>thought two</thinking>\n\nstep 2')
    expect(asst[0]?.content).toBe('step 1')
    expect(asst[0]?.toolUses).toEqual([{ input: { n: 1 }, name: 'calc', toolUseId: 'tu1' }])
  })

  test('string content without reasoning_content is unchanged', () => {
    const msgs = toolLoopMsgs([undefined, undefined])
    const history = buildHistory(msgs, MODEL)
    expect(asstEntries(history)[0]?.content).toBe('step 1')
  })

  test('empty content + reasoning_content yields a bare <thinking> block', () => {
    const msgs = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'only thinking',
        tool_calls: [{ id: 'tu1', function: { name: 'calc', arguments: '{}' } }]
      },
      { role: 'tool', content: 'res', tool_call_id: 'tu1' }
    ]
    const history = buildHistory(msgs, MODEL)
    expect(asstEntries(history)[0]?.content).toBe('<thinking>only thinking</thinking>')
  })

  test('array content with thinking parts keeps working (regression)', () => {
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
    expect(asstEntries(history)[0]?.content).toBe('<thinking>hmm</thinking>\n\nanswer')
  })

  test('turns outside the in-flight tool loop are not replayed', () => {
    const msgs = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'old answer', reasoning_content: 'old thought' },
      { role: 'user', content: 'second question' },
      {
        role: 'assistant',
        content: 'step',
        reasoning_content: 'current thought',
        tool_calls: [{ id: 'tu1', function: { name: 'calc', arguments: '{}' } }]
      },
      { role: 'tool', content: 'res', tool_call_id: 'tu1' }
    ]
    const contents = asstEntries(buildHistory(msgs, MODEL)).map((a) => a.content)
    expect(contents.some((c) => c.includes('old thought'))).toBe(false)
    expect(contents.some((c) => c.includes('current thought'))).toBe(true)
  })

  test('a completed loop followed by a new user turn is not replayed', () => {
    const msgs = [...toolLoopMsgs(['t1', 't2']), { role: 'user', content: 'new question' }]
    expect(JSON.stringify(buildHistory(msgs, MODEL))).not.toContain('<thinking>')
  })

  test('collapseAgenticLoops preserves visible tool text while bounding reasoning replay', () => {
    const msgs = toolLoopMsgs(['t1', 't2', 't3', 't4'])
    const serialized = JSON.stringify(buildHistory(msgs, MODEL))
    expect(serialized).toContain('<thinking>t4</thinking>')
    expect(serialized).not.toContain('<thinking>t1</thinking>')
    expect(serialized).not.toContain('<thinking>t2</thinking>')
    expect(serialized).not.toContain('<thinking>t3</thinking>')
    expect(serialized).toContain('step 2')
    expect(serialized).toContain('step 3')
    expect(serialized).not.toContain('tool calling continues')
  })
})

describe('buildCodeWhispererRequest — current assistant turn', () => {
  test('trailing assistant turn recovers reasoning_content into history content', () => {
    const req = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'answer', reasoning_content: 'cur thought' }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )
    const history = (req.conversationState as any).history as ReturnType<typeof buildHistory>
    const last = asstEntries(history).at(-1)
    expect(last?.content).toBe('<thinking>cur thought</thinking>\n\nanswer')
  })

  test('trailing assistant turn with both tool calls and reasoning keeps both', () => {
    const req = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'q' },
          {
            role: 'assistant',
            content: 'calling',
            reasoning_content: 'need the tool',
            tool_calls: [{ id: 'tu9', function: { name: 'calc', arguments: '{"n":9}' } }]
          }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )
    const history = (req.conversationState as any).history as ReturnType<typeof buildHistory>
    const last = asstEntries(history).at(-1)
    expect(last?.content).toBe('<thinking>need the tool</thinking>\n\ncalling')
    expect(last?.toolUses).toEqual([{ input: { n: 9 }, name: 'calc', toolUseId: 'tu9' }])
  })

  test('trailing assistant array content with thinking parts is unchanged (regression)', () => {
    const req = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'q' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'legacy' },
              { type: 'text', text: 'reply' }
            ]
          }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )
    const history = (req.conversationState as any).history as ReturnType<typeof buildHistory>
    expect(asstEntries(history).at(-1)?.content).toBe('<thinking>legacy</thinking>\n\nreply')
  })

  test('recovered reasoning never reaches assistantResponseMessage.reasoningContent', () => {
    const req = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'answer', reasoning_content: 'cur thought' }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )
    const serialized = JSON.stringify(req.conversationState)
    expect(serialized).toContain('<thinking>cur thought</thinking>')
    expect(serialized).not.toContain('reasoningContent')
    expect(serialized).not.toContain('reasoning_content')
  })
})
