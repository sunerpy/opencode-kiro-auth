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

export interface AssistantReplayScope {
  /** Native signed replay is allowed only for one unmerged turn in the active tool loop. */
  readonly recoverReasoning: boolean
  /** The signature-miss `<thinking>` text fallback is allowed for one turn only. */
  readonly allowThinkingText: boolean
}

/**
 * Rebuild one assistant turn from its inbound OpenAI-compatible shape.
 *
 * A signature hit emits native `reasoningContent` and no thinking text. On a miss the
 * thinking-text fallback is retained byte-for-byte, but only for the turn the caller
 * marks with `allowThinkingText`; every other turn keeps its visible content and tool
 * uses and drops the thinking text. This is the single funnel for both channels the
 * fallback reaches — `response.content` and the `fallbackContent` the history builder
 * restores when it merges adjacent assistant turns.
 */
export function reconstructAssistantResponse(
  message: unknown,
  effectiveModel: string,
  scope: AssistantReplayScope
): ReconstructedAssistantResponse {
  const parsed = parseAssistantMessage(message, { recoverReasoning: scope.recoverReasoning })
  const thinkingText = scope.allowThinkingText ? parsed.thinking : ''
  const fallbackContent = applyThinkingToContent(parsed.content, thinkingText)
  const reasoningContent =
    scope.recoverReasoning && !spansMultipleAssistantSourceTurns(message)
      ? resolveSignedReasoning({
          message,
          visibleText: parsed.content,
          toolUses: parsed.toolUses,
          effectiveModel
        })
      : undefined
  const response: AssistantResponse = {
    content: applyThinkingToContent(parsed.content, thinkingText, reasoningContent !== undefined)
  }
  if (parsed.toolUses.length > 0) response.toolUses = parsed.toolUses
  if (reasoningContent !== undefined) response.reasoningContent = reasoningContent

  return { response, fallbackContent }
}
