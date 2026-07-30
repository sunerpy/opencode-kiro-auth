import {
  applyThinkingToContent,
  extractReasoningText,
  parseAssistantMessage,
  spansMultipleAssistantSourceTurns
} from '../../infrastructure/transformers/message-transformer.js'
import type { CodeWhispererMessage } from '../types.js'
import { reasoningCorrelationCache } from './correlation-cache.js'
import { normalizeToolArguments } from './turn-identity.js'

type AssistantResponse = NonNullable<CodeWhispererMessage['assistantResponseMessage']>
type NativeReasoningContent = NonNullable<AssistantResponse['reasoningContent']>

export interface ReconstructedAssistantResponse {
  readonly response: AssistantResponse
  readonly fallbackContent: string
}

interface ReplayLookupInput {
  readonly message: unknown
  readonly visibleText: string
  readonly toolUses: AssistantResponse['toolUses']
  readonly effectiveModel: string
}

function resolveSignedReasoning(input: ReplayLookupInput): NativeReasoningContent | undefined {
  const reasoningText = extractReasoningText(input.message)
  if (reasoningText.length === 0) return undefined

  const result = reasoningCorrelationCache.lookup({
    reasoningText,
    visibleText: input.visibleText,
    toolUses: (input.toolUses ?? []).map((toolUse) => ({
      toolUseId: toolUse.toolUseId,
      name: toolUse.name,
      argumentsJson: normalizeToolArguments(toolUse.input)
    })),
    effectiveModel: input.effectiveModel
  })
  const envelope = result.envelope
  if (envelope?.kind !== 'reasoningText' || envelope.signature.length === 0) return undefined

  return {
    reasoningText: {
      text: envelope.text,
      signature: envelope.signature
    }
  }
}

/**
 * Rebuild one assistant turn from its inbound OpenAI-compatible shape.
 *
 * Native replay is allowed only for one unmerged source turn in the active
 * tool loop. A cache miss (or any refusal) retains Wave 1's thinking-text
 * fallback byte-for-byte.
 */
export function reconstructAssistantResponse(
  message: unknown,
  effectiveModel: string,
  recoverReasoning: boolean
): ReconstructedAssistantResponse {
  const parsed = parseAssistantMessage(message, { recoverReasoning })
  const fallbackContent = applyThinkingToContent(parsed.content, parsed.thinking)
  const reasoningContent =
    recoverReasoning && !spansMultipleAssistantSourceTurns(message)
      ? resolveSignedReasoning({
          message,
          visibleText: parsed.content,
          toolUses: parsed.toolUses,
          effectiveModel
        })
      : undefined
  const response: AssistantResponse = {
    content: applyThinkingToContent(parsed.content, parsed.thinking, reasoningContent !== undefined)
  }
  if (parsed.toolUses.length > 0) response.toolUses = parsed.toolUses
  if (reasoningContent !== undefined) response.reasoningContent = reasoningContent

  return { response, fallbackContent }
}
