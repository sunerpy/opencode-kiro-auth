import { describe, expect, test } from 'bun:test'
import { buildHistory, injectSystemPrompt } from '../infrastructure/transformers/history-builder.js'
import { sanitizeHistory } from '../infrastructure/transformers/message-transformer.js'
import { transformToSdkRequest } from '../plugin/request.js'
import type { CodeWhispererMessage, KiroAuthDetails } from '../plugin/types.js'

const MODEL = 'claude-sonnet-4.5'
const MODEL_VARIANT = 'claude-sonnet-4-5'
const AUTH: KiroAuthDetails = {
  refresh: 'refresh-token',
  access: 'access-token',
  expires: Date.now() + 3_600_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

describe('tool-result content consistency', () => {
  test('history tool-result turn leaves content empty', () => {
    const history = buildHistory(
      [
        { role: 'user', content: 'run it' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', function: { name: 'runner' } }]
        },
        { role: 'tool', content: 'done', tool_call_id: 'call-1' },
        { role: 'user', content: 'next turn' }
      ],
      MODEL
    )

    const toolResultTurn = history.find(
      (message) => message.userInputMessage?.userInputMessageContext?.toolResults
    )
    expect(toolResultTurn?.userInputMessage?.content).toBe('')
  })

  test('current tool-result message leaves content empty', () => {
    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'run it' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call-1', function: { name: 'runner' } }]
          },
          { role: 'tool', content: 'done', tool_call_id: 'call-1' }
        ]
      },
      MODEL_VARIANT,
      AUTH
    )

    expect(request.conversationState.currentMessage.userInputMessage?.content).toBe('')
  })

  test('history and current tool-result sites stay byte-identical', () => {
    const messages = [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-1', function: { name: 'runner' } }]
      },
      { role: 'tool', content: 'done', tool_call_id: 'call-1' }
    ]
    const history = buildHistory([...messages, { role: 'user', content: 'next turn' }], MODEL)
    const historyContent = history.find(
      (message) => message.userInputMessage?.userInputMessageContext?.toolResults
    )?.userInputMessage?.content
    const request = transformToSdkRequest({ messages }, MODEL_VARIANT, AUTH)
    const currentContent = request.conversationState.currentMessage.userInputMessage?.content

    expect(historyContent).toBe(currentContent)
  })

  test('empty current message without tool results keeps the continuation placeholder', () => {
    const request = transformToSdkRequest(
      { messages: [{ role: 'user', content: '' }] },
      MODEL_VARIANT,
      AUTH
    )

    expect(request.conversationState.currentMessage.userInputMessage?.content).toBe(
      '[system: conversation continues]'
    )
  })
})

describe('empty tool-result history safety', () => {
  test('sanitizeHistory removes a leading tool pair but preserves a later matched empty turn', () => {
    const history: CodeWhispererMessage[] = [
      {
        assistantResponseMessage: {
          content: 'orphan call',
          toolUses: [{ input: {}, name: 'runner', toolUseId: 'orphan' }]
        }
      },
      {
        userInputMessage: {
          content: '',
          modelId: MODEL,
          origin: 'AI_EDITOR',
          userInputMessageContext: {
            toolResults: [{ toolUseId: 'orphan', content: [{ text: 'old' }], status: 'success' }]
          }
        }
      },
      { userInputMessage: { content: 'real user turn', modelId: MODEL, origin: 'AI_EDITOR' } },
      {
        assistantResponseMessage: {
          content: 'active call',
          toolUses: [{ input: {}, name: 'runner', toolUseId: 'active' }]
        }
      },
      {
        userInputMessage: {
          content: '',
          modelId: MODEL,
          origin: 'AI_EDITOR',
          userInputMessageContext: {
            toolResults: [{ toolUseId: 'active', content: [{ text: 'new' }], status: 'success' }]
          }
        }
      }
    ]

    const sanitized = sanitizeHistory(history)
    const activeResult = sanitized.find(
      (message) =>
        message.userInputMessage?.userInputMessageContext?.toolResults?.[0]?.toolUseId === 'active'
    )
    expect(sanitized[0]?.userInputMessage?.content).toBe('real user turn')
    expect(activeResult?.userInputMessage?.content).toBe('')
  })

  test('injectSystemPrompt targets the real user turn before an empty tool-result turn', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'real user turn', modelId: MODEL, origin: 'AI_EDITOR' } },
      {
        assistantResponseMessage: {
          content: 'calling',
          toolUses: [{ input: {}, name: 'runner', toolUseId: 'call-1' }]
        }
      },
      {
        userInputMessage: {
          content: '',
          modelId: MODEL,
          origin: 'AI_EDITOR',
          userInputMessageContext: {
            toolResults: [{ toolUseId: 'call-1', content: [{ text: 'done' }], status: 'success' }]
          }
        }
      }
    ]

    const result = injectSystemPrompt(history, 'SYSTEM', MODEL)
    const toolResultTurn = result.find(
      (message) => message.userInputMessage?.userInputMessageContext?.toolResults
    )
    expect(result[0]?.userInputMessage?.content).toBe('SYSTEM\n\nreal user turn')
    expect(toolResultTurn?.userInputMessage?.content).toBe('')
  })
})
