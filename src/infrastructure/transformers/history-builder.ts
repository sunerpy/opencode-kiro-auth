import { KIRO_CONSTANTS } from '../../constants.js'
import {
  MAX_KIRO_IMAGES,
  convertImagesToKiroFormat,
  extractAllImages,
  extractTextFromParts
} from '../../plugin/image-handler.js'
import { reconstructAssistantResponse } from '../../plugin/reasoning/request-replay.js'
import type { CodeWhispererMessage } from '../../plugin/types'
import {
  findActiveToolLoopStart,
  findThinkingTextReplayIndex,
  getContentText
} from './message-transformer.js'
import { deduplicateToolResults } from './tool-transformer.js'

/**
 * Collapse agentic loop sequences in the built history.
 *
 * Each agentic iteration gets a fresh conversationId, so the model re-derives its preamble
 * (intent detection, greeting) every iteration. When replayed for the next user turn, the
 * model sees duplicate preambles and gets confused.
 *
 * Strips text from intermediate ASST(toolUses)→USER(toolResults) pairs, keeping only the
 * first assistant text and all tool_use/tool_result pairs.
 *
 * Collapsed turns carry `content: ''`, matching the official Kiro IDE shape for a
 * tool-only assistant turn. A placeholder string here is not cosmetic: the model reads
 * it as dozens of in-context examples of what an assistant turn looks like when it is
 * about to call a tool, and echoes it verbatim instead of emitting a real tool call.
 */
export function collapseAgenticLoops(history: CodeWhispererMessage[]): CodeWhispererMessage[] {
  if (history.length < 4) return history

  const result: CodeWhispererMessage[] = []
  let i = 0

  while (i < history.length) {
    const entry = history[i]

    if (
      entry?.assistantResponseMessage?.toolUses &&
      i + 1 < history.length &&
      history[i + 1]?.userInputMessage?.userInputMessageContext?.toolResults
    ) {
      const seqStart = i

      let j = i
      while (j < history.length) {
        const asst = history[j]
        if (!asst?.assistantResponseMessage?.toolUses) break
        const nextUser = j + 1 < history.length ? history[j + 1] : null
        if (!nextUser?.userInputMessage?.userInputMessageContext?.toolResults) break
        j += 2
      }

      const seqEnd = j
      const pairCount = (seqEnd - seqStart) / 2

      if (pairCount > 1) {
        for (let k = seqStart; k < seqEnd; k += 2) {
          const asst = history[k]
          const user = history[k + 1]

          if (!asst?.assistantResponseMessage || !user) continue
          const assistantResponse = asst.assistantResponseMessage

          if (k === seqStart) {
            result.push(asst)
          } else {
            if (!assistantResponse.toolUses) continue
            result.push({
              assistantResponseMessage: {
                content: '',
                toolUses: assistantResponse.toolUses,
                ...(assistantResponse.reasoningContent !== undefined
                  ? { reasoningContent: assistantResponse.reasoningContent }
                  : {})
              }
            })
          }
          result.push(user)
        }
      } else {
        for (let k = seqStart; k < seqEnd; k++) {
          result.push(history[k]!)
        }
      }

      i = seqEnd
    } else {
      result.push(entry!)
      i++
    }
  }

  return result
}

type KiroUserTurn = NonNullable<CodeWhispererMessage['userInputMessage']>

/**
 * Fold a user-shaped turn into the preceding history entry when that entry is also
 * user-shaped, reporting whether it was absorbed.
 *
 * Kiro expects `history` to alternate user/assistant, yet a transcript legitimately
 * places two user-shaped entries side by side: a text message followed by tool
 * results, tool results followed by a fresh instruction, or two client-side user
 * messages. Synthesizing an assistant turn to separate them puts
 * system-directive-looking text into assistant content, which the model reads as an
 * in-context example of its own voice and reproduces verbatim instead of issuing a
 * real tool call. Merging removes the need for a separator at the root, matching
 * jwadow/kiro-gateway PR #238 and Kiro-Go's adjacent tool-result merge.
 *
 * The surviving entry keeps its position and its own `modelId`/`origin`, so ordering
 * and wire metadata are untouched. Images are capped at the converter's own per-turn
 * limit, because two merged turns can otherwise exceed what the API accepts.
 */
function mergeIntoPreviousUserTurn(
  history: CodeWhispererMessage[],
  incoming: KiroUserTurn
): boolean {
  const previous = history[history.length - 1]?.userInputMessage
  if (!previous) return false

  if (incoming.content) {
    previous.content = previous.content
      ? `${previous.content}\n\n${incoming.content}`
      : incoming.content
  }

  const incomingResults = incoming.userInputMessageContext?.toolResults
  if (incomingResults && incomingResults.length > 0) {
    const context = (previous.userInputMessageContext ??= {})
    context.toolResults = deduplicateToolResults([
      ...(context.toolResults ?? []),
      ...incomingResults
    ])
  }

  if (incoming.images && incoming.images.length > 0) {
    const combined = [...(previous.images ?? []), ...incoming.images]
    previous.images = combined.slice(0, MAX_KIRO_IMAGES)
    const omitted = combined.length - previous.images.length
    if (omitted > 0) {
      previous.content = `${previous.content}\n\n[${omitted} image(s) omitted due to API limits]`
    }
  }

  return true
}

export function buildHistory(msgs: any[], resolved: string): CodeWhispererMessage[] {
  let history: CodeWhispererMessage[] = []
  const fallbackByAssistant = new Map<
    NonNullable<CodeWhispererMessage['assistantResponseMessage']>,
    string
  >()
  const loopStart = findActiveToolLoopStart(msgs)
  const thinkingReplayIndex = findThinkingTextReplayIndex(msgs)
  for (let i = 0; i < msgs.length - 1; i++) {
    const m = msgs[i]
    if (!m) continue
    if (m.role === 'user') {
      const uim: any = { content: '', modelId: resolved, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR }
      const trs: any[] = []

      if (Array.isArray(m.content)) {
        uim.content = extractTextFromParts(m.content)

        for (const p of m.content) {
          if (p.type === 'tool_result') {
            trs.push({
              content: [{ text: getContentText(p.content || p) }],
              status: 'success',
              toolUseId: p.tool_use_id
            })
          }
        }

        const unifiedImages = extractAllImages(m.content)
        if (unifiedImages.length > 0) {
          const { images, omitted } = convertImagesToKiroFormat(unifiedImages)
          uim.images = images
          if (omitted > 0) {
            uim.content += `\n\n[${omitted} image(s) omitted due to API limits]`
          }
        }
      } else {
        uim.content = getContentText(m)
      }

      if (trs.length) uim.userInputMessageContext = { toolResults: deduplicateToolResults(trs) }
      if (!mergeIntoPreviousUserTurn(history, uim)) history.push({ userInputMessage: uim })
    } else if (m.role === 'tool') {
      const trs: any[] = []
      if (m.tool_results) {
        for (const tr of m.tool_results)
          trs.push({
            content: [{ text: getContentText(tr) }],
            status: 'success',
            toolUseId: tr.tool_call_id
          })
      } else {
        trs.push({
          content: [{ text: getContentText(m) }],
          status: 'success',
          toolUseId: m.tool_call_id
        })
      }
      const toolTurn: KiroUserTurn = {
        content: '',
        modelId: resolved,
        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
        userInputMessageContext: { toolResults: deduplicateToolResults(trs) }
      }
      if (!mergeIntoPreviousUserTurn(history, toolTurn))
        history.push({ userInputMessage: toolTurn })
    } else if (m.role === 'assistant') {
      const reconstructed = reconstructAssistantResponse(m, resolved, {
        recoverReasoning: i >= loopStart,
        allowThinkingText: i === thinkingReplayIndex
      })
      const arm = reconstructed.response

      if (!arm.content && !arm.toolUses && !arm.reasoningContent) {
        continue
      }

      const prevMsg = history[history.length - 1]
      if (prevMsg && prevMsg.assistantResponseMessage) {
        // Merge consecutive assistant messages instead of injecting synthetic user turn
        const prev = prevMsg.assistantResponseMessage
        const previousFallback = fallbackByAssistant.get(prev)
        if (previousFallback !== undefined) {
          prev.content = previousFallback
          fallbackByAssistant.delete(prev)
        }
        delete prev.reasoningContent
        if (reconstructed.fallbackContent) {
          prev.content = prev.content
            ? `${prev.content}\n\n${reconstructed.fallbackContent}`
            : reconstructed.fallbackContent
        }
        if (arm.toolUses) {
          prev.toolUses = [...(prev.toolUses || []), ...arm.toolUses]
        }
      } else {
        history.push({ assistantResponseMessage: arm })
        fallbackByAssistant.set(arm, reconstructed.fallbackContent)
      }
    }
  }
  return collapseAgenticLoops(history)
}

export function injectSystemPrompt(
  history: CodeWhispererMessage[],
  system: string | undefined,
  resolved: string
): CodeWhispererMessage[] {
  if (!system) return history
  const firstUserMsg = history.find((h) => !!h.userInputMessage)
  if (firstUserMsg && firstUserMsg.userInputMessage) {
    const oldContent = firstUserMsg.userInputMessage.content || ''
    firstUserMsg.userInputMessage.content = `${system}\n\n${oldContent}`
  } else {
    history.unshift({
      userInputMessage: {
        content: system,
        modelId: resolved,
        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
      }
    })
  }
  return history
}

export function historyHasToolCalling(history: CodeWhispererMessage[]): boolean {
  return history.some(
    (h) =>
      h.assistantResponseMessage?.toolUses ||
      h.userInputMessage?.userInputMessageContext?.toolResults
  )
}

export function extractToolNamesFromHistory(history: CodeWhispererMessage[]): Set<string> {
  const toolNames = new Set<string>()
  for (const h of history) {
    if (h.assistantResponseMessage?.toolUses) {
      for (const tu of h.assistantResponseMessage.toolUses) {
        if (tu.name) toolNames.add(tu.name)
      }
    }
  }
  return toolNames
}
