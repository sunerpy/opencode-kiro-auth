import { parseAwsEventStreamBuffer } from '../infrastructure/transformers/event-stream-parser.js'
import {
  cleanToolCallsFromText,
  deduplicateToolCalls,
  parseBracketToolCalls
} from '../infrastructure/transformers/tool-call-parser.js'
import { getContextWindowSize } from './models.js'
import { ParsedResponse, ToolCall } from './types'

export function parseEventStream(rawResponse: string, model?: string): ParsedResponse {
  const parsedFromEvents = parseEventStreamChunk(rawResponse, model)
  let fullResponseText = parsedFromEvents.content
  let allToolCalls = [...parsedFromEvents.toolCalls]

  const rawBracketToolCalls = parseBracketToolCalls(rawResponse)
  if (rawBracketToolCalls.length > 0) {
    allToolCalls.push(...rawBracketToolCalls)
  }

  const uniqueToolCalls = deduplicateToolCalls(allToolCalls)

  if (uniqueToolCalls.length > 0) {
    fullResponseText = cleanToolCallsFromText(fullResponseText, uniqueToolCalls)
  }

  return {
    content: fullResponseText,
    toolCalls: uniqueToolCalls,
    stopReason: parsedFromEvents.stopReason,
    inputTokens: parsedFromEvents.inputTokens,
    outputTokens: parsedFromEvents.outputTokens
  }
}

function parseEventStreamChunk(rawText: string, model?: string): ParsedResponse {
  const events = parseAwsEventStreamBuffer(rawText)

  let content = ''
  const toolCallsMap = new Map<string, ToolCall>()
  let stopReason: string | undefined
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let contextUsagePercentage: number | undefined

  for (const event of events) {
    if (event.type === 'content' && event.data) {
      content += event.data
    } else if (event.type === 'toolUse') {
      const { name, toolUseId, input } = event.data
      if (name && toolUseId) {
        if (toolCallsMap.has(toolUseId)) {
          const existing = toolCallsMap.get(toolUseId)!
          existing.input = (existing.input as string) + (input || '')
        } else {
          toolCallsMap.set(toolUseId, {
            toolUseId,
            name,
            input: input || ''
          })
        }
      }
    } else if (event.type === 'toolUseInput') {
      const lastToolCall = Array.from(toolCallsMap.values()).pop()
      if (lastToolCall) {
        lastToolCall.input = (lastToolCall.input as string) + (event.data.input || '')
      }
    } else if (event.type === 'toolUseStop') {
      stopReason = 'tool_use'
    } else if (event.type === 'contextUsage') {
      contextUsagePercentage = event.data.contextUsagePercentage
    }
  }

  const toolCalls: ToolCall[] = Array.from(toolCallsMap.values()).map((tc) => {
    let parsedInput: Record<string, unknown> | string = tc.input
    if (typeof tc.input === 'string' && tc.input.trim()) {
      try {
        parsedInput = JSON.parse(tc.input)
      } catch (e) {
        parsedInput = tc.input
      }
    }
    return {
      toolUseId: tc.toolUseId,
      name: tc.name,
      input: parsedInput
    }
  })

  if (contextUsagePercentage !== undefined) {
    const contextWindow = getContextWindowSize(model || '')
    const totalTokens = Math.round((contextWindow * contextUsagePercentage) / 100)
    outputTokens = estimateTokens(content)
    inputTokens = Math.max(0, totalTokens - outputTokens)
  }

  return {
    content,
    toolCalls,
    stopReason: stopReason || (toolCalls.length > 0 ? 'tool_use' : 'end_turn'),
    inputTokens,
    outputTokens
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
