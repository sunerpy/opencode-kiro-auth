import type { CodeWhispererMessage } from '../../plugin/types'

// Object identity is sufficient for the refusal path: mergeAdjacentMessages
// creates the exact post-merge object later consumed by request/history builders.
// No source envelope is carried or selected across this boundary.
const multiSourceAssistantMessages = new WeakSet<object>()

export function sanitizeHistory(history: CodeWhispererMessage[]): CodeWhispererMessage[] {
  const result: CodeWhispererMessage[] = []
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    if (!m) continue
    if (m.assistantResponseMessage?.toolUses) {
      const next = history[i + 1]
      if (next?.userInputMessage?.userInputMessageContext?.toolResults) {
        result.push(m)
      }
    } else if (m.userInputMessage?.userInputMessageContext?.toolResults) {
      const prev = result[result.length - 1]
      if (prev?.assistantResponseMessage?.toolUses) {
        result.push(m)
      }
    } else {
      result.push(m)
    }
  }

  while (result.length > 0) {
    const first = result[0]
    if (first?.userInputMessage && !first.userInputMessage.userInputMessageContext?.toolResults)
      break
    result.shift()
  }
  if (result.length === 0) return []

  while (result.length > 0 && result[result.length - 1]?.assistantResponseMessage) {
    result.pop()
  }

  return result
}

export function findOriginalToolCall(msgs: any[], toolUseId: string): any | null {
  for (const m of msgs) {
    if (m.role === 'assistant') {
      if (m.tool_calls) {
        for (const tc of m.tool_calls) if (tc.id === toolUseId) return tc
      }
      if (Array.isArray(m.content)) {
        for (const p of m.content) if (p.type === 'tool_use' && p.id === toolUseId) return p
      }
    }
  }
  return null
}

export function mergeAdjacentMessages(msgs: any[]): any[] {
  const merged: any[] = []
  for (const m of msgs) {
    if (!merged.length) merged.push({ ...m })
    else {
      const last = merged[merged.length - 1]
      if (last && m.role === last.role) {
        if (m.role === 'assistant') multiSourceAssistantMessages.add(last)
        if (Array.isArray(last.content) && Array.isArray(m.content)) last.content.push(...m.content)
        else if (typeof last.content === 'string' && typeof m.content === 'string')
          last.content += '\n' + m.content
        else if (Array.isArray(last.content) && typeof m.content === 'string')
          last.content.push({ type: 'text', text: m.content })
        else if (typeof last.content === 'string' && Array.isArray(m.content))
          last.content = [{ type: 'text', text: last.content }, ...m.content]
        if (m.tool_calls) {
          if (!last.tool_calls) last.tool_calls = []
          last.tool_calls.push(...m.tool_calls)
        }
        if (m.role === 'tool') {
          if (!last.tool_results)
            last.tool_results = [{ content: last.content, tool_call_id: last.tool_call_id }]
          last.tool_results.push({ content: m.content, tool_call_id: m.tool_call_id })
        }
      } else merged.push({ ...m })
    }
  }
  return merged
}

/** True when normalization combined two or more inbound assistant turns. */
export function spansMultipleAssistantSourceTurns(message: unknown): boolean {
  return (
    typeof message === 'object' && message !== null && multiSourceAssistantMessages.has(message)
  )
}

export interface ParsedAssistantMessage {
  content: string
  thinking: string
  toolUses: Array<{ input: any; name: string; toolUseId: string }>
}

/**
 * Extract the reasoning text an OpenAI-compatible assistant message carries at
 * the top level.
 *
 * `@ai-sdk/openai-compatible` serializes assistant reasoning as a top-level
 * `reasoning_content` **string** while `content` stays a plain string, so the
 * array-shaped `type: 'thinking'` parts never appear on the OpenCode path.
 * Arrays are tolerated for callers that send Anthropic-style parts.
 */
export function extractReasoningText(m: any): string {
  const rc = m?.reasoning_content
  if (typeof rc === 'string') return rc
  if (Array.isArray(rc))
    return rc.map((p: any) => (typeof p === 'string' ? p : p?.text || p?.thinking || '')).join('')
  return ''
}

/**
 * Index of the first message of the in-flight tool loop, i.e. the maximal
 * trailing run of `assistant(tool calls)` → tool-result messages.
 *
 * Returns `msgs.length` when the conversation does not end inside a tool loop,
 * which bounds reasoning recovery to the loop currently being executed instead
 * of replaying every historical assistant turn.
 */
export function findActiveToolLoopStart(msgs: any[]): number {
  let start = msgs.length
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (!m) break
    if (isToolResultMessage(m)) {
      start = i
      continue
    }
    if (m.role === 'assistant' && assistantHasToolCalls(m)) {
      start = i
      continue
    }
    break
  }
  return start
}

function isToolResultMessage(m: any): boolean {
  if (m.role === 'tool') return true
  if (m.role !== 'user') return false
  return Array.isArray(m.content) && m.content.some((p: any) => p?.type === 'tool_result')
}

function assistantHasToolCalls(m: any): boolean {
  if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true
  return Array.isArray(m.content) && m.content.some((p: any) => p?.type === 'tool_use')
}

/**
 * Shared assistant-message parser for both history construction
 * (`buildHistory`) and the current-turn branch in `buildCodeWhispererRequest`.
 *
 * With `recoverReasoning`, a top-level `reasoning_content` string is used when
 * the message carries no array-shaped `thinking` parts; array parts always win
 * so existing Anthropic-style callers are unaffected.
 */
export function parseAssistantMessage(
  m: any,
  options?: { recoverReasoning?: boolean }
): ParsedAssistantMessage {
  let content = ''
  let thinking = ''
  const toolUses: Array<{ input: any; name: string; toolUseId: string }> = []

  if (Array.isArray(m?.content)) {
    for (const p of m.content) {
      if (p.type === 'text') content += p.text || ''
      else if (p.type === 'thinking') thinking += p.thinking || p.text || ''
      else if (p.type === 'tool_use')
        toolUses.push({ input: p.input, name: p.name, toolUseId: p.id })
    }
  } else content = getContentText(m)

  if (m?.tool_calls && Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      toolUses.push({
        input:
          typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function?.arguments,
        name: tc.function?.name,
        toolUseId: tc.id
      })
    }
  }

  if (!thinking && options?.recoverReasoning) thinking = extractReasoningText(m)

  return { content, thinking, toolUses }
}

export function applyThinkingToContent(
  content: string,
  thinking: string,
  hasNativeReasoning = false
): string {
  if (hasNativeReasoning) return content
  if (!thinking) return content
  return content
    ? `<thinking>${thinking}</thinking>\n\n${content}`
    : `<thinking>${thinking}</thinking>`
}

export function getContentText(m: any): string {
  if (!m) return ''
  if (typeof m === 'string') return m
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content))
    return m.content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text || '')
      .join('')
  return m.text || ''
}
