import { describeReasoningContentForLog } from '../../plugin/log-redaction.js'
import type {
  CodeWhispererMessage,
  ManagedAccount,
  SdkPreparedRequest
} from '../../plugin/types.js'

export interface HistoryReasoningSummary {
  index: number
  envelope: ReturnType<typeof describeReasoningContentForLog>
}

export function summarizeHistoryReasoning(
  history: readonly CodeWhispererMessage[] | undefined
): HistoryReasoningSummary[] {
  if (!history) return []
  const summaries: HistoryReasoningSummary[] = []
  history.forEach((entry, index) => {
    const envelope = entry.assistantResponseMessage?.reasoningContent
    if (envelope) summaries.push({ index, envelope: describeReasoningContentForLog(envelope) })
  })
  return summaries
}

/**
 * The API-log payload for one outbound `generateAssistantResponse` call. Carries the
 * request shape, never the replayed history itself: only `historyLength` plus a
 * per-turn sanitized reasoning summary (§6.8).
 */
export function buildSdkRequestLogPayload(
  prep: SdkPreparedRequest,
  account: Pick<ManagedAccount, 'email'>
): Record<string, unknown> {
  const history = prep.conversationState.history
  const historyReasoning = summarizeHistoryReasoning(history)
  return {
    url: `https://q.${prep.region}.amazonaws.com/generateAssistantResponse`,
    method: 'POST',
    headers: { 'x-amzn-kiro-agent-mode': 'vibe' },
    body: {
      conversationState: {
        chatTriggerType: prep.conversationState.chatTriggerType,
        conversationId: prep.conversationState.conversationId,
        historyLength: history?.length ?? 0,
        ...(historyReasoning.length > 0 ? { historyReasoning } : {}),
        currentMessage: prep.conversationState.currentMessage
      },
      profileArn: prep.profileArn
    },
    conversationId: prep.conversationId,
    model: prep.effectiveModel,
    email: account.email
  }
}
