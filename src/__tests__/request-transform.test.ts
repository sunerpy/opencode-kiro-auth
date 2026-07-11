import { describe, expect, test } from 'bun:test'
import { transformToCodeWhisperer, transformToSdkRequest } from '../plugin/request.js'
import type { KiroAuthDetails } from '../plugin/types.js'

const auth: KiroAuthDetails = {
  refresh: 'r',
  access: 'access-token',
  expires: Date.now() + 3_600_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

const authWithProfile: KiroAuthDetails = {
  ...auth,
  profileArn: 'arn:aws:codewhisperer:eu-west-1:123456789012:profile/ABC'
}

function uim(req: ReturnType<typeof transformToSdkRequest>) {
  return req.conversationState.currentMessage.userInputMessage!
}

describe('transformToSdkRequest — currentMessage structure', () => {
  test('single user message -> currentMessage with content, modelId, origin', () => {
    const req = transformToSdkRequest(
      { messages: [{ role: 'user', content: 'hello world' }] },
      'claude-sonnet-4-5',
      auth
    )
    expect(uim(req).content).toBe('hello world')
    expect(uim(req).modelId).toBe('claude-sonnet-4.5')
    expect(uim(req).origin).toBe('AI_EDITOR')
    expect(req.conversationState.chatTriggerType).toBe('MANUAL')
    expect(typeof req.conversationState.conversationId).toBe('string')
    expect(req.streaming).toBe(true)
  })

  test('accepts a JSON string body (parsed internally)', () => {
    const req = transformToSdkRequest(
      JSON.stringify({ messages: [{ role: 'user', content: 'str-body' }] }),
      'claude-sonnet-4-5',
      auth
    )
    expect(uim(req).content).toBe('str-body')
  })

  test('throws when there are no messages', () => {
    expect(() => transformToSdkRequest({ messages: [] }, 'claude-sonnet-4-5', auth)).toThrow(
      'No messages'
    )
  })
})

// The current turn's content stays the raw user text; the system prompt is
// injected as a leading userInputMessage in `history` (via injectSystemPrompt),
// which for a single user turn creates a synthetic system history entry.
function firstHistoryUserContent(
  req: ReturnType<typeof transformToSdkRequest>
): string | undefined {
  const hist = req.conversationState.history || []
  return hist.find((h) => h.userInputMessage)?.userInputMessage?.content
}

describe('transformToSdkRequest — system extraction', () => {
  test('top-level system field is injected as the leading history user turn', () => {
    const req = transformToSdkRequest(
      { system: 'You are helpful.', messages: [{ role: 'user', content: 'hi' }] },
      'claude-sonnet-4-5',
      auth
    )
    expect(firstHistoryUserContent(req)).toBe('You are helpful.')
    expect(uim(req).content).toBe('hi')
  })

  test('system role messages are extracted and merged with top-level system', () => {
    const req = transformToSdkRequest(
      {
        system: 'TOP',
        messages: [
          { role: 'system', content: 'ROLE-SYS' },
          { role: 'user', content: 'hi' }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )
    expect(firstHistoryUserContent(req)).toBe('TOP\n\nROLE-SYS')
    expect(uim(req).content).toBe('hi')
  })

  test('multiple system role messages joined with double newline', () => {
    const req = transformToSdkRequest(
      {
        messages: [
          { role: 'system', content: 'A' },
          { role: 'system', content: 'B' },
          { role: 'user', content: 'q' }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )
    expect(firstHistoryUserContent(req)).toBe('A\n\nB')
    expect(uim(req).content).toBe('q')
  })
})

describe('transformToSdkRequest — thinking prefix injection', () => {
  test('think=true injects thinking_mode prefix as leading history system turn', () => {
    const req = transformToSdkRequest(
      { messages: [{ role: 'user', content: 'q' }] },
      'claude-sonnet-4-5',
      auth,
      true,
      15000
    )
    expect(firstHistoryUserContent(req)).toBe(
      '<thinking_mode>enabled</thinking_mode><max_thinking_length>15000</max_thinking_length>'
    )
    expect(uim(req).content).toBe('q')
  })

  test('think=true with existing system prepends prefix above system text', () => {
    const req = transformToSdkRequest(
      { system: 'SYS', messages: [{ role: 'user', content: 'q' }] },
      'claude-sonnet-4-5',
      auth,
      true,
      20000
    )
    expect(firstHistoryUserContent(req)).toBe(
      '<thinking_mode>enabled</thinking_mode><max_thinking_length>20000</max_thinking_length>\nSYS'
    )
  })

  test('does not double-inject when system already contains <thinking_mode>', () => {
    const req = transformToSdkRequest(
      {
        system: '<thinking_mode>enabled</thinking_mode> already',
        messages: [{ role: 'user', content: 'q' }]
      },
      'claude-sonnet-4-5',
      auth,
      true,
      20000
    )
    expect(firstHistoryUserContent(req)).toBe('<thinking_mode>enabled</thinking_mode> already')
  })
})

describe('transformToSdkRequest — tools mapping', () => {
  test('tools are converted and attached to userInputMessageContext.tools', () => {
    const req = transformToSdkRequest(
      {
        messages: [{ role: 'user', content: 'use a tool' }],
        tools: [
          {
            function: {
              name: 'get_time',
              description: 'get the time',
              parameters: { type: 'object', properties: {} }
            }
          }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )
    expect(uim(req).userInputMessageContext?.tools).toEqual([
      {
        toolSpecification: {
          name: 'get_time',
          description: 'get the time',
          inputSchema: { json: { type: 'object', properties: {} } }
        }
      }
    ])
  })

  test('no tools -> no userInputMessageContext', () => {
    const req = transformToSdkRequest(
      { messages: [{ role: 'user', content: 'plain' }] },
      'claude-sonnet-4-5',
      auth
    )
    expect(uim(req).userInputMessageContext).toBeUndefined()
  })
})

describe('transformToSdkRequest — tool_use / tool_result flow', () => {
  test('assistant tool_use in history + tool_result becomes matched toolResults', () => {
    const req = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'run it' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu1', name: 'runner', input: { x: 1 } }]
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'done' }]
          }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )
    // the current turn carries the tool_result matched against history's tool_use
    const ctx = uim(req).userInputMessageContext
    expect(ctx?.toolResults).toEqual([
      { content: [{ text: 'done' }], status: 'success', toolUseId: 'tu1' }
    ])
    // and the assistant tool_use is present in history
    const hist = req.conversationState.history || []
    const asst = hist.find((h) => h.assistantResponseMessage?.toolUses)
    expect(asst?.assistantResponseMessage?.toolUses?.[0]?.toolUseId).toBe('tu1')
  })

  test('current assistant turn -> currentMessage placeholder + assistant appended to history', () => {
    const req = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'partial answer' }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )
    expect(uim(req).content).toBe('[system: conversation continues]')
    const hist = req.conversationState.history || []
    const asst = hist[hist.length - 1]
    expect(asst?.assistantResponseMessage?.content).toBe('partial answer')
  })
})

describe('transformToSdkRequest — profileArn / region resolution', () => {
  test('profileArn is copied and region derived from the ARN', () => {
    const req = transformToSdkRequest(
      { messages: [{ role: 'user', content: 'q' }] },
      'claude-sonnet-4-5',
      authWithProfile
    )
    expect(req.profileArn).toBe(authWithProfile.profileArn)
    expect(req.region).toBe('eu-west-1')
  })

  test('no profileArn -> falls back to auth.region and profileArn omitted', () => {
    const req = transformToSdkRequest(
      { messages: [{ role: 'user', content: 'q' }] },
      'claude-sonnet-4-5',
      auth
    )
    expect(req.profileArn).toBeUndefined()
    expect(req.region).toBe('us-east-1')
  })
})

describe('transformToSdkRequest — current-turn branches', () => {
  test('current tool role message emits toolResults matched against history tool_use', () => {
    const req = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'c9', function: { name: 'f' } }] },
          { role: 'tool', content: 'the-result', tool_call_id: 'c9' }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )
    expect(uim(req).userInputMessageContext?.toolResults).toEqual([
      { content: [{ text: 'the-result' }], status: 'success', toolUseId: 'c9' }
    ])
  })

  test('current assistant turn with tool_calls (string args) appends toolUses to history', () => {
    const req = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'q' },
          {
            role: 'assistant',
            content: 'part',
            tool_calls: [{ id: 'x1', function: { name: 'g', arguments: '{"k":2}' } }]
          }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )
    const hist = req.conversationState.history || []
    const asst = hist[hist.length - 1]?.assistantResponseMessage
    expect(asst?.toolUses).toEqual([{ input: { k: 2 }, name: 'g', toolUseId: 'x1' }])
  })

  test('current assistant turn with thinking part wraps content in <thinking>', () => {
    const req = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'q' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'deliberating' },
              { type: 'text', text: 'final' }
            ]
          }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )
    const hist = req.conversationState.history || []
    expect(hist[hist.length - 1]?.assistantResponseMessage?.content).toBe(
      '<thinking>deliberating</thinking>\n\nfinal'
    )
    expect(uim(req).content).toBe('[system: conversation continues]')
  })

  test('tool_result whose call cannot be found is inlined into current content', () => {
    const req = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'lead' },
          { role: 'assistant', content: 'no tool use here' },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'stray-output' }]
          }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )
    expect(uim(req).content).toContain('[Output for tool call ghost]')
    expect(uim(req).content).toContain('stray-output')
    expect(uim(req).userInputMessageContext?.toolResults).toBeUndefined()
  })

  test('current user turn with array content extracts text into currentMessage', () => {
    const req = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: [{ type: 'text', text: 'multi-part current' }] }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )
    expect(uim(req).content).toBe('multi-part current')
  })
})

describe('transformToCodeWhisperer — HTTP prepared request', () => {
  test('builds POST init with Kiro headers and JSON body containing conversationState', () => {
    const prepared = transformToCodeWhisperer(
      'ignored-url',
      { messages: [{ role: 'user', content: 'hi' }] },
      'claude-sonnet-4-5',
      auth
    )
    expect(prepared.init.method).toBe('POST')
    const headers = prepared.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer access-token')
    expect(headers['x-amzn-kiro-agent-mode']).toBe('vibe')
    expect(headers['x-amz-user-agent']).toContain('KiroIDE')
    expect(prepared.streaming).toBe(true)
    expect(prepared.effectiveModel).toBe('claude-sonnet-4.5')

    const body = JSON.parse(prepared.init.body as string)
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe('hi')
    expect(body.conversationState.currentMessage.userInputMessage.modelId).toBe('claude-sonnet-4.5')
  })

  test('url targets the resolved region host', () => {
    const prepared = transformToCodeWhisperer(
      'ignored',
      { messages: [{ role: 'user', content: 'hi' }] },
      'claude-sonnet-4-5',
      authWithProfile
    )
    expect(prepared.url).toContain('eu-west-1')
    expect(prepared.url).toContain('generateAssistantResponse')
  })
})
