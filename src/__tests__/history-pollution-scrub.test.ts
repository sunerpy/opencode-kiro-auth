import { describe, expect, test } from 'bun:test'
import {
  parseAssistantMessage,
  stripPollutionMarkers
} from '../infrastructure/transformers/message-transformer.js'
import { transformToSdkRequest } from '../plugin/request.js'
import type { CodeWhispererMessage, KiroAuthDetails } from '../plugin/types.js'

const MODEL = 'claude-sonnet-4-5'

const auth: KiroAuthDetails = {
  refresh: 'r',
  access: 'access-token',
  expires: Date.now() + 3_600_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

const TOOL_MARKER = '[system: tool calling continues]'
const CONVERSATION_MARKER = '[system: conversation continues]'

function toolChainMsgs(pairs: number, firstAssistantText: string): any[] {
  const msgs: any[] = [{ role: 'user', content: 'run the whole chain' }]
  for (let turn = 1; turn <= pairs; turn++) {
    msgs.push({
      role: 'assistant',
      content: turn === 1 ? firstAssistantText : `step ${turn}`,
      tool_calls: [{ id: `tu${turn}`, function: { name: 'calc', arguments: `{"n":${turn}}` } }]
    })
    msgs.push({ role: 'tool', content: `result ${turn}`, tool_call_id: `tu${turn}` })
  }
  return msgs
}

function allEntries(state: any): CodeWhispererMessage[] {
  return [...((state.history ?? []) as CodeWhispererMessage[]), state.currentMessage]
}

describe('stripPollutionMarkers', () => {
  test('text carrying no marker is returned byte-for-byte', () => {
    const samples = [
      'a plain answer',
      'trailing whitespace kept   ',
      'blank\n\n\nline run kept',
      '  leading kept',
      'a bracketed [system: something else] phrase',
      ''
    ]
    for (const sample of samples) expect(stripPollutionMarkers(sample)).toBe(sample)
  })

  test('a marker that is the entire text collapses to an empty string', () => {
    expect(stripPollutionMarkers(TOOL_MARKER)).toBe('')
    expect(stripPollutionMarkers(CONVERSATION_MARKER)).toBe('')
    expect(stripPollutionMarkers(`\n\n${TOOL_MARKER}\n`)).toBe('')
  })

  test('a marker at the start is removed without disturbing the answer', () => {
    expect(stripPollutionMarkers(`${TOOL_MARKER} code? no output. Need run.`)).toBe(
      'code? no output. Need run.'
    )
    expect(stripPollutionMarkers(`${TOOL_MARKER}\n\nHere is the fix.`)).toBe('Here is the fix.')
  })

  test('a marker between two fragments leaves the separator they already had', () => {
    expect(stripPollutionMarkers(`A\n\n${TOOL_MARKER}\n\nB`)).toBe('A\n\nB')
    expect(stripPollutionMarkers(`A\n${CONVERSATION_MARKER}\nB`)).toBe('A\nB')
    expect(stripPollutionMarkers(`A ${TOOL_MARKER} B`)).toBe('A B')
  })

  test('both marker literals are removed from the same text', () => {
    expect(stripPollutionMarkers(`${CONVERSATION_MARKER}\n\nreal\n\n${TOOL_MARKER}`)).toBe('real')
  })
})

describe('parseAssistantMessage inbound scrubbing', () => {
  test('a replayed marker is scrubbed while toolUses survive untouched', () => {
    const parsed = parseAssistantMessage({
      role: 'assistant',
      content: `${TOOL_MARKER} reading the file now`,
      tool_calls: [{ id: 'tu1', function: { name: 'read', arguments: '{"path":"a.ts"}' } }]
    })
    expect(parsed.content).toBe('reading the file now')
    expect(parsed.toolUses).toEqual([{ input: { path: 'a.ts' }, name: 'read', toolUseId: 'tu1' }])
  })

  test('a marker replayed inside reasoning_content is scrubbed too', () => {
    const parsed = parseAssistantMessage(
      { role: 'assistant', content: 'answer', reasoning_content: `${TOOL_MARKER}\n\nthought` },
      { recoverReasoning: true }
    )
    expect(parsed.thinking).toBe('thought')
  })

  test('an unpolluted assistant message parses byte-for-byte', () => {
    const message = {
      role: 'assistant',
      content: 'plain   answer\n\n\nwith gaps  ',
      reasoning_content: 'raw   thought  '
    }
    const parsed = parseAssistantMessage(message, { recoverReasoning: true })
    expect(parsed.content).toBe('plain   answer\n\n\nwith gaps  ')
    expect(parsed.thinking).toBe('raw   thought  ')
  })
})

describe('client-replayed pollution never reaches the wire', () => {
  test('a polluted assistant turn is scrubbed before the request is built', () => {
    const msgs = toolChainMsgs(2, `${TOOL_MARKER} Let me check the file.`)
    msgs.push({ role: 'user', content: 'now summarize' })

    const request = transformToSdkRequest({ messages: msgs }, MODEL, auth)
    const serialized = JSON.stringify(request.conversationState)

    expect(serialized).not.toContain('tool calling continues')
    expect(serialized).toContain('Let me check the file.')
  })

  test('pollution replayed as the current assistant turn is scrubbed', () => {
    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: `${TOOL_MARKER}\n\nfinal answer` }
        ]
      },
      MODEL,
      auth
    )
    const entries = allEntries(request.conversationState)
    const replayed = entries.flatMap((e) => (e.assistantResponseMessage ? [e] : []))

    expect(replayed.at(-1)?.assistantResponseMessage?.content).toBe('final answer')
  })
})

describe('long tool chain leaves no marker on the wire', () => {
  const msgs = toolChainMsgs(5, 'starting the chain')
  const request = transformToSdkRequest({ messages: msgs }, MODEL, auth)
  const state: any = request.conversationState
  const serialized = JSON.stringify(state)

  test('the collapse produced at least three emptied assistant turns', () => {
    const emptied = ((state.history ?? []) as CodeWhispererMessage[]).filter(
      (e) => e.assistantResponseMessage?.toolUses && e.assistantResponseMessage.content === ''
    )
    expect(emptied.length).toBeGreaterThanOrEqual(3)
  })

  test('the full serialization contains neither marker literal', () => {
    expect(serialized).not.toContain('tool calling continues')
    expect(serialized).not.toContain('conversation continues')
  })

  test('no assistant turn carries an empty toolUses array', () => {
    expect(serialized).not.toContain('"toolUses":[]')
    for (const entry of allEntries(state)) {
      const toolUses = entry.assistantResponseMessage?.toolUses
      if (toolUses !== undefined) expect(toolUses.length).toBeGreaterThan(0)
    }
  })

  test('currentMessage content is empty only when tool results accompany it', () => {
    const uim = state.currentMessage.userInputMessage
    const toolResults = uim.userInputMessageContext?.toolResults ?? []
    if (uim.content.length === 0) expect(toolResults.length).toBeGreaterThan(0)
    else expect(uim.content.length).toBeGreaterThan(0)
  })
})

describe('wire shape invariants across turn kinds', () => {
  const shapes: Array<{ label: string; messages: any[] }> = [
    { label: 'plain user turn', messages: [{ role: 'user', content: 'hello' }] },
    {
      label: 'assistant-final turn',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' }
      ]
    },
    { label: 'tool-final turn', messages: toolChainMsgs(3, 'begin') },
    {
      label: 'empty user turn',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: '' }
      ]
    }
  ]

  for (const shape of shapes) {
    test(`${shape.label}: content non-empty unless toolResults are present`, () => {
      const state: any = transformToSdkRequest(
        { messages: shape.messages },
        MODEL,
        auth
      ).conversationState
      const uim = state.currentMessage.userInputMessage
      const toolResults = uim.userInputMessageContext?.toolResults ?? []
      if (uim.content.length === 0) expect(toolResults.length).toBeGreaterThan(0)
      else expect(uim.content.length).toBeGreaterThan(0)
    })

    test(`${shape.label}: no empty toolUses array is emitted`, () => {
      const state: any = transformToSdkRequest(
        { messages: shape.messages },
        MODEL,
        auth
      ).conversationState
      expect(JSON.stringify(state)).not.toContain('"toolUses":[]')
    })
  }
})
