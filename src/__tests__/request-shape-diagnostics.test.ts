import { describe, expect, test } from 'bun:test'
import {
  buildRequestShapeDiagnostics,
  buildStreamTerminalDiagnostics,
  createDiagnosticContext,
  diagnosticContextLogFields
} from '../core/request/request-shape-diagnostics.js'
import type { SdkPreparedRequest } from '../plugin/types.js'

const SECRET_PROMPT = 'deploy project aurora with customer token alpha-secret'
const SECRET_TOOL = 'deploy_customer_alpha'
const SECRET_ARGUMENT = '/srv/customer-alpha/private'

function preparedRequest(): SdkPreparedRequest {
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'wire-secret-id',
      history: [
        {
          userInputMessage: {
            content: SECRET_PROMPT,
            modelId: 'claude-opus-5',
            origin: 'AI_EDITOR'
          }
        },
        {
          assistantResponseMessage: {
            content: '',
            toolUses: [
              {
                toolUseId: 'call-secret',
                name: SECRET_TOOL,
                input: { path: SECRET_ARGUMENT }
              }
            ]
          }
        },
        {
          userInputMessage: {
            content: 'Running tools...',
            modelId: 'claude-opus-5',
            origin: 'AI_EDITOR'
          }
        },
        {
          assistantResponseMessage: {
            content: 'I will execute the following tools.',
            toolUses: [
              {
                toolUseId: 'orphan-secret',
                name: SECRET_TOOL,
                input: { path: SECRET_ARGUMENT }
              }
            ]
          }
        }
      ],
      currentMessage: {
        userInputMessage: {
          content: '[system: conversation continues]',
          modelId: 'claude-opus-5',
          origin: 'AI_EDITOR',
          userInputMessageContext: {
            toolResults: [
              {
                toolUseId: 'orphan-secret',
                content: [{ text: 'private tool output' }],
                status: 'success'
              }
            ],
            tools: [
              {
                toolSpecification: {
                  name: SECRET_TOOL,
                  description: 'private deployment tool',
                  inputSchema: { json: { type: 'object' } }
                }
              }
            ]
          }
        }
      }
    },
    streaming: true,
    effectiveModel: 'claude-opus-5',
    conversationId: 'wire-secret-id',
    region: 'us-east-1',
    effort: 'high'
  }
}

const inboundBody = {
  model: 'claude-opus-5',
  messages: [
    { role: 'system', content: 'private system instructions' },
    { role: 'user', content: SECRET_PROMPT },
    {
      role: 'assistant',
      content: '[system: tool calling continues]',
      tool_calls: [
        {
          id: 'call-secret',
          type: 'function',
          function: {
            name: SECRET_TOOL,
            arguments: JSON.stringify({ path: SECRET_ARGUMENT })
          }
        }
      ]
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'orphan-secret', content: 'private output' }]
    }
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: SECRET_TOOL,
        description: 'private deployment tool',
        parameters: { type: 'object' }
      }
    }
  ],
  tool_choice: { type: 'function', function: { name: SECRET_TOOL } }
}

describe('request shape diagnostics', () => {
  test('basic reports counts without verbose sequences or tool hashes', () => {
    const result = buildRequestShapeDiagnostics(inboundBody, preparedRequest(), 'basic')

    expect(result).toMatchObject({
      diagnosticSchemaVersion: 1,
      diagnosticLogLevel: 'basic',
      inputMessageCount: 4,
      inputLastRole: 'user',
      inputCurrentTurnKind: 'tool_result_only',
      inputToolCount: 1,
      inputToolChoice: 'named',
      wireHistoryLength: 4,
      wireCurrentContentKind: 'protocol_marker',
      wireCurrentToolResultCount: 1,
      wireCurrentToolCount: 1,
      wireHistoryToolUseCount: 2,
      wireOrphanRepairAssistantCount: 1
    })
    expect(result).not.toHaveProperty('inputRoleSequence')
    expect(result).not.toHaveProperty('inputToolSetHash')
  })

  test('verbose adds bounded structural detail while leaking no content or names', () => {
    const result = buildRequestShapeDiagnostics(inboundBody, preparedRequest(), 'verbose')
    const serialized = JSON.stringify(result)

    expect(result).toMatchObject({
      inputRoleSequence: 's,u,a,u',
      wireRoleSequence: 'u,a,u,a,u',
      inputSyntheticMarkerHitCount: 1,
      wireSyntheticMarkerHitCount: 1,
      wireEmptyAssistantCount: 1,
      wireOrphanRepairAssistantCount: 1,
      inputToolSetHash: expect.stringMatching(/^[a-f0-9]{16}$/),
      wireToolSetHash: expect.stringMatching(/^[a-f0-9]{16}$/)
    })
    expect(serialized).not.toContain(SECRET_PROMPT)
    expect(serialized).not.toContain(SECRET_TOOL)
    expect(serialized).not.toContain(SECRET_ARGUMENT)
    expect(serialized).not.toContain('private tool output')
    expect(serialized).not.toContain('wire-secret-id')
  })

  test('off produces no correlation or terminal diagnostics', () => {
    const context = createDiagnosticContext('off', {
      diagnosticTraceId: 'f95ab753-632a-4d4f-8dd2-fb4860123456',
      sessionHash: 'a'.repeat(16)
    })

    expect(diagnosticContextLogFields(context)).toEqual({})
    expect(
      buildStreamTerminalDiagnostics('off', 'clean_eof_without_completion_metadata', 0)
    ).toEqual({})
  })

  test('basic terminal evidence distinguishes synthesized stop from upstream failure', () => {
    expect(
      buildStreamTerminalDiagnostics('basic', 'clean_eof_without_completion_metadata', 0)
    ).toEqual({
      terminalProvenance: 'clean_eof',
      downstreamFinishReason: 'stop',
      downstreamFinishReasonProvenance: 'synthesized_from_tool_count'
    })
    expect(buildStreamTerminalDiagnostics('basic', 'iterator_failure', 0)).toEqual({
      terminalProvenance: 'upstream_error',
      downstreamFinishReason: null,
      downstreamFinishReasonProvenance: null
    })
  })
})
