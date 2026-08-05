import { createHash, randomUUID } from 'node:crypto'
import type { DiagnosticLogLevel } from '../../plugin/config/schema.js'
import type { RequestTerminalSource } from '../../plugin/streaming/stream-observer.js'
import type { CodeWhispererMessage, SdkPreparedRequest } from '../../plugin/types.js'
import type { KiroRequestDiagnostics } from './request-kind.js'

export const REQUEST_SHAPE_DIAGNOSTICS_LOG = 'Kiro request shape diagnostics'

const DIAGNOSTIC_SCHEMA_VERSION = 1
const TOOL_SET_HASH_LENGTH = 16
const MAX_ROLE_SEQUENCE_LENGTH = 64
const POLLUTION_MARKERS = [
  '[system: tool calling continues]',
  '[system: conversation continues]'
] as const
const ORPHAN_REPAIR_ASSISTANT_CONTENT = 'I will execute the following tools.'
const FLATTENED_ORPHAN_PREFIX = '[Output for tool call '

type InputRole = 'system' | 'user' | 'assistant' | 'tool' | 'other'

export interface DiagnosticContext extends KiroRequestDiagnostics {
  readonly level: DiagnosticLogLevel
}

function parseBody(body: unknown): Record<string, any> {
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body)
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
      return {}
    }
  }
  return typeof body === 'object' && body !== null ? (body as Record<string, any>) : {}
}

function normalizeRole(value: unknown): InputRole {
  return value === 'system' || value === 'user' || value === 'assistant' || value === 'tool'
    ? value
    : 'other'
}

function roleCode(role: InputRole): string {
  switch (role) {
    case 'system':
      return 's'
    case 'user':
      return 'u'
    case 'assistant':
      return 'a'
    case 'tool':
      return 't'
    case 'other':
      return 'o'
  }
}

function stringContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  let result = ''
  for (const part of value) {
    if (typeof part === 'string') {
      result += part
      continue
    }
    if (typeof part !== 'object' || part === null) continue
    const record = part as Record<string, unknown>
    if (typeof record.text === 'string') result += record.text
    else if (typeof record.thinking === 'string') result += record.thinking
    else if (typeof record.content === 'string') result += record.content
    else if (Array.isArray(record.content)) result += stringContent(record.content)
  }
  return result
}

function nonToolTextLength(message: any): number {
  if (typeof message?.content === 'string') return message.content.length
  if (!Array.isArray(message?.content)) return 0
  let length = 0
  for (const part of message.content) {
    if (typeof part === 'string') {
      length += part.length
      continue
    }
    if (typeof part !== 'object' || part === null) continue
    if (part.type === 'tool_result' || part.type === 'tool_use') continue
    length += stringContent(part).length
  }
  return length
}

function messageToolResultCount(message: any): number {
  let count = Array.isArray(message?.tool_results) ? message.tool_results.length : 0
  if (Array.isArray(message?.content)) {
    count += message.content.filter((part: any) => part?.type === 'tool_result').length
  }
  if (message?.role === 'tool' && count === 0) count = 1
  return count
}

function messageToolUseCount(message: any): number {
  let count = Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0
  if (Array.isArray(message?.content)) {
    count += message.content.filter((part: any) => part?.type === 'tool_use').length
  }
  return count
}

function toolName(tool: any): string | undefined {
  const candidate =
    tool?.function?.name ??
    tool?.name ??
    tool?.toolSpecification?.name ??
    tool?.tool_specification?.name
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

function inputToolNames(request: Record<string, any>): string[] {
  if (!Array.isArray(request.tools)) return []
  return request.tools.map(toolName).filter((name): name is string => name !== undefined)
}

function wireToolNames(prepared: SdkPreparedRequest): string[] {
  const current =
    prepared.conversationState.currentMessage.userInputMessage?.userInputMessageContext?.tools ?? []
  return current.map(toolName).filter((name): name is string => name !== undefined)
}

function toolSetHash(names: string[]): string | null {
  const normalized = [...new Set(names)].sort()
  if (normalized.length === 0) return null
  return createHash('sha256')
    .update(normalized.join('\0'))
    .digest('hex')
    .slice(0, TOOL_SET_HASH_LENGTH)
}

function countMarkers(text: string): number {
  let count = 0
  for (const marker of POLLUTION_MARKERS) {
    let offset = 0
    while (offset < text.length) {
      const index = text.indexOf(marker, offset)
      if (index === -1) break
      count++
      offset = index + marker.length
    }
  }
  return count
}

function inputMarkerCount(messages: any[]): number {
  let count = 0
  for (const message of messages) {
    if (normalizeRole(message?.role) !== 'assistant') continue
    count += countMarkers(stringContent(message?.content))
    count += countMarkers(stringContent(message?.thinking))
    count += countMarkers(stringContent(message?.reasoning_content))
  }
  return count
}

function wireMarkerCount(messages: CodeWhispererMessage[]): number {
  let count = 0
  for (const message of messages) {
    count += countMarkers(message.userInputMessage?.content ?? '')
    count += countMarkers(message.assistantResponseMessage?.content ?? '')
  }
  return count
}

function inputRoleCounts(messages: any[]): Record<InputRole, number> {
  const counts: Record<InputRole, number> = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0,
    other: 0
  }
  for (const message of messages) counts[normalizeRole(message?.role)]++
  return counts
}

function wireRole(message: CodeWhispererMessage): 'user' | 'assistant' | 'ambiguous' | 'empty' {
  const user = message.userInputMessage !== undefined
  const assistant = message.assistantResponseMessage !== undefined
  if (user && assistant) return 'ambiguous'
  if (user) return 'user'
  if (assistant) return 'assistant'
  return 'empty'
}

function wireRoleCode(message: CodeWhispererMessage): string {
  switch (wireRole(message)) {
    case 'user':
      return 'u'
    case 'assistant':
      return 'a'
    case 'ambiguous':
      return 'x'
    case 'empty':
      return 'o'
  }
}

function wireRoleCounts(messages: CodeWhispererMessage[]): Record<string, number> {
  const counts = { user: 0, assistant: 0, ambiguous: 0, empty: 0 }
  for (const message of messages) counts[wireRole(message)]++
  return counts
}

function boundedRoleSequence(codes: string[]): { value: string; truncated: boolean } {
  const truncated = codes.length > MAX_ROLE_SEQUENCE_LENGTH
  return {
    value: codes.slice(-MAX_ROLE_SEQUENCE_LENGTH).join(','),
    truncated
  }
}

function currentTurnKind(message: any): string {
  const role = normalizeRole(message?.role)
  const toolResults = messageToolResultCount(message)
  if (role === 'assistant') return 'assistant_continuation'
  if (role === 'tool') return 'tool_result_only'
  if (role === 'user' && toolResults > 0) {
    return nonToolTextLength(message) > 0 ? 'tool_result_with_text' : 'tool_result_only'
  }
  if (role === 'user') return 'user_message'
  if (role === 'system') return 'system_message'
  return 'other'
}

function toolChoiceKind(value: unknown): string {
  if (value === undefined || value === null) return 'absent'
  if (value === 'auto' || value === 'none' || value === 'required') return value
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, any>
    if (typeof record.function?.name === 'string' || typeof record.name === 'string') return 'named'
  }
  return 'other'
}

function contentKind(content: string): string {
  if (content.length === 0) return 'empty'
  if (POLLUTION_MARKERS.includes(content as (typeof POLLUTION_MARKERS)[number])) {
    return 'protocol_marker'
  }
  return 'text'
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while (offset < text.length) {
    const index = text.indexOf(needle, offset)
    if (index === -1) break
    count++
    offset = index + needle.length
  }
  return count
}

function wireAlternates(messages: CodeWhispererMessage[]): boolean {
  const roles = messages.map(wireRole)
  if (roles.some((role) => role !== 'user' && role !== 'assistant')) return false
  return roles.every((role, index) => index === 0 || role !== roles[index - 1])
}

export function createDiagnosticContext(
  level: DiagnosticLogLevel,
  diagnostics: KiroRequestDiagnostics
): DiagnosticContext {
  if (level === 'off') return { level }
  return {
    level,
    diagnosticTraceId: diagnostics.diagnosticTraceId ?? randomUUID(),
    ...(diagnostics.sessionHash !== undefined ? { sessionHash: diagnostics.sessionHash } : {}),
    ...(diagnostics.agentHash !== undefined ? { agentHash: diagnostics.agentHash } : {}),
    ...(diagnostics.messageHash !== undefined ? { messageHash: diagnostics.messageHash } : {})
  }
}

export function diagnosticContextLogFields(context: DiagnosticContext): Record<string, unknown> {
  if (context.level === 'off') return {}
  return {
    diagnosticLogLevel: context.level,
    diagnosticTraceId: context.diagnosticTraceId,
    sessionHash: context.sessionHash ?? null,
    agentHash: context.agentHash ?? null,
    messageHash: context.messageHash ?? null
  }
}

export function buildRequestShapeDiagnostics(
  body: unknown,
  prepared: SdkPreparedRequest,
  level: DiagnosticLogLevel
): Record<string, unknown> {
  if (level === 'off') return {}
  const request = parseBody(body)
  const messages = Array.isArray(request.messages) ? request.messages : []
  const lastMessage = messages[messages.length - 1]
  const history = prepared.conversationState.history ?? []
  const current = prepared.conversationState.currentMessage.userInputMessage
  const currentContext = current?.userInputMessageContext
  const inputNames = inputToolNames(request)
  const wireNames = wireToolNames(prepared)
  const wireHistoryToolUses = history.reduce(
    (count, message) => count + (message.assistantResponseMessage?.toolUses?.length ?? 0),
    0
  )
  const wireHistoryToolResults = history.reduce(
    (count, message) =>
      count + (message.userInputMessage?.userInputMessageContext?.toolResults?.length ?? 0),
    0
  )
  const wireEmptyAssistants = history.filter(
    (message) => message.assistantResponseMessage?.content === ''
  ).length
  const repairAssistants = history.filter(
    (message) =>
      message.assistantResponseMessage?.content === ORPHAN_REPAIR_ASSISTANT_CONTENT &&
      (message.assistantResponseMessage.toolUses?.length ?? 0) > 0
  ).length
  const currentContent = current?.content ?? ''
  const basic: Record<string, unknown> = {
    diagnosticSchemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    diagnosticLogLevel: level,
    inputMessageCount: messages.length,
    inputRoleCounts: inputRoleCounts(messages),
    inputLastRole: messages.length > 0 ? normalizeRole(lastMessage?.role) : null,
    inputCurrentTurnKind: messages.length > 0 ? currentTurnKind(lastMessage) : 'absent',
    inputToolCount: inputNames.length,
    inputToolChoice: toolChoiceKind(request.tool_choice ?? request.toolChoice),
    inputToolUseCount: messages.reduce(
      (count: number, message: any) => count + messageToolUseCount(message),
      0
    ),
    inputToolResultCount: messages.reduce(
      (count: number, message: any) => count + messageToolResultCount(message),
      0
    ),
    wireHistoryLength: history.length,
    wireHistoryRoleCounts: wireRoleCounts(history),
    wireHistoryToolUseCount: wireHistoryToolUses,
    wireHistoryToolResultCount: wireHistoryToolResults,
    wireCurrentContentKind: contentKind(currentContent),
    wireCurrentContentChars: currentContent.length,
    wireCurrentToolResultCount: currentContext?.toolResults?.length ?? 0,
    wireCurrentToolCount: currentContext?.tools?.length ?? 0,
    wireEmptyAssistantCount: wireEmptyAssistants,
    wireOrphanRepairAssistantCount: repairAssistants
  }
  if (level !== 'verbose') return basic

  const inputSequence = boundedRoleSequence(
    messages.map((message: any) => roleCode(normalizeRole(message?.role)))
  )
  const wireMessages = [...history, prepared.conversationState.currentMessage]
  const wireSequence = boundedRoleSequence(wireMessages.map(wireRoleCode))
  const inputNameSet = new Set(inputNames)
  return {
    ...basic,
    inputRoleSequence: inputSequence.value,
    inputRoleSequenceTruncated: inputSequence.truncated,
    wireRoleSequence: wireSequence.value,
    wireRoleSequenceTruncated: wireSequence.truncated,
    wireHistoryAlternates: wireAlternates(history),
    wireHistoryEndsWithRole: history.length > 0 ? wireRole(history[history.length - 1]!) : null,
    inputEmptyAssistantCount: messages.filter(
      (message: any) =>
        normalizeRole(message?.role) === 'assistant' && nonToolTextLength(message) === 0
    ).length,
    inputSyntheticMarkerHitCount: inputMarkerCount(messages),
    wireSyntheticMarkerHitCount: wireMarkerCount(wireMessages),
    wireReasoningEnvelopeCount: history.filter(
      (message) => message.assistantResponseMessage?.reasoningContent !== undefined
    ).length,
    wireFlattenedOrphanResultCount: countOccurrences(currentContent, FLATTENED_ORPHAN_PREFIX),
    wireInferredToolCount: wireNames.filter((name) => !inputNameSet.has(name)).length,
    inputToolSetHash: toolSetHash(inputNames),
    wireToolSetHash: toolSetHash(wireNames),
    wireCurrentImageCount: current?.images?.length ?? 0
  }
}

function terminalProvenance(source: RequestTerminalSource | null): string {
  switch (source) {
    case 'clean_eof_without_completion_metadata':
      return 'clean_eof'
    case 'completion_metadata_received':
      return 'completion_metadata'
    case 'semantic_truncation':
      return 'semantic_truncation'
    case 'caller_abort':
      return 'caller_abort'
    case 'stream_attempt_budget_exhausted':
      return 'recovery_exhausted'
    case 'iterator_failure':
    case 'http_error':
    case 'network_error':
      return 'upstream_error'
    case 'stream_processing_failure':
    case 'request_error':
      return 'processing_error'
    case null:
      return 'unknown'
  }
}

export function buildStreamTerminalDiagnostics(
  level: DiagnosticLogLevel,
  source: RequestTerminalSource | null,
  emittedToolCount: number
): Record<string, unknown> {
  if (level === 'off') return {}
  const cleanEnd =
    source === 'clean_eof_without_completion_metadata' || source === 'completion_metadata_received'
  return {
    terminalProvenance: terminalProvenance(source),
    downstreamFinishReason: cleanEnd ? (emittedToolCount > 0 ? 'tool-calls' : 'stop') : null,
    downstreamFinishReasonProvenance: cleanEnd ? 'synthesized_from_tool_count' : null
  }
}
