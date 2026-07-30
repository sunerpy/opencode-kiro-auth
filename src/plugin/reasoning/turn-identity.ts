import { createHash } from 'node:crypto'
import { findActiveToolLoopStart } from '../../infrastructure/transformers/message-transformer.js'
import type { EmittedToolUse } from './emitted-output.js'

/**
 * Turn identity for the reasoning correlation cache.
 *
 * Two independent identities live here:
 *
 * - the **fingerprint key**, which must be reconstructible from the inbound
 *   assistant message alone (so it deliberately excludes the producing account —
 *   the next turn cannot know it, and a signature is valid across accounts);
 * - the **`loopId`**, derived from the ordered non-empty `tool_use` ids of the
 *   first assistant turn of the current contiguous tool loop. Not from the
 *   leading prompt: two concurrent agents can open with byte-identical prompts,
 *   and compaction rewrites those leading turns.
 */

/** A tool call in fingerprint form. `name` matters — same args to two tools are two turns. */
export interface FingerprintToolUse {
  toolUseId: string
  name: string
  argumentsJson: string
}

export interface FingerprintInput {
  /** The exact reasoning text of the turn, as emitted / as received back. */
  reasoningText: string
  /** The exact visible answer text of the turn. */
  visibleText: string
  toolUses: FingerprintToolUse[]
  /** The model resolved for the CURRENT request, used purely as a namespace. */
  effectiveModel: string
}

/**
 * Normalize a tool-argument payload the same way on both sides of the boundary.
 *
 * `transformSdkStream` emits `JSON.stringify(JSON.parse(input))` for tool
 * arguments, and OpenCode hands the same string back, so re-normalizing is
 * idempotent — but doing it explicitly means a re-serialized-but-equivalent
 * inbound payload still matches, while an unparseable payload is compared
 * verbatim rather than being silently rewritten.
 */
export function normalizeToolArguments(raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'string') {
    try {
      return JSON.stringify(JSON.parse(raw))
    } catch {
      return raw
    }
  }
  try {
    return JSON.stringify(raw)
  } catch {
    return ''
  }
}

function lengthPrefixed(value: string): string {
  return `${value.length}:${value}`
}

/**
 * Deterministic, collision-resistant cache key.
 *
 * Every field is length-prefixed so no delimiter sequence inside a payload can
 * forge a different field layout. The model is kept in the clear as a namespace
 * prefix: a mid-conversation model switch must produce a safe MISS, never a
 * cross-model replay.
 */
export function computeFingerprintKey(input: FingerprintInput): string {
  const parts: string[] = [
    lengthPrefixed(input.reasoningText),
    lengthPrefixed(input.visibleText),
    lengthPrefixed(String(input.toolUses.length))
  ]
  for (const tool of input.toolUses) {
    parts.push(lengthPrefixed(tool.name))
    parts.push(lengthPrefixed(tool.toolUseId))
    parts.push(lengthPrefixed(tool.argumentsJson))
  }
  const digest = createHash('sha256').update(parts.join('|'), 'utf8').digest('hex')
  return `${input.effectiveModel}\u0000${digest}`
}

/**
 * Loop root identity from an ordered list of `tool_use` ids.
 *
 * Refuses (returns `undefined`) when the list is empty or any id is empty:
 * an unidentifiable root must never be cached under a guessed identity.
 */
export function loopIdFromToolUseIds(ids: readonly string[]): string | undefined {
  if (ids.length === 0) return undefined
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) return undefined
  }
  return `loop:${ids.join(',')}`
}

/** Loop root identity from the tool calls a response just emitted. */
export function loopIdFromEmittedToolUses(toolUses: readonly EmittedToolUse[]): string | undefined {
  return loopIdFromToolUseIds(toolUses.map((tool) => tool.toolUseId))
}

function assistantToolUseIds(message: unknown): string[] | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const record = message as Record<string, unknown>
  if (record.role !== 'assistant') return undefined

  const ids: string[] = []
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (typeof part !== 'object' || part === null) continue
      const partRecord = part as Record<string, unknown>
      if (partRecord.type !== 'tool_use') continue
      ids.push(typeof partRecord.id === 'string' ? partRecord.id : '')
    }
  }
  if (Array.isArray(record.tool_calls)) {
    for (const call of record.tool_calls) {
      if (typeof call !== 'object' || call === null) continue
      const callRecord = call as Record<string, unknown>
      ids.push(typeof callRecord.id === 'string' ? callRecord.id : '')
    }
  }
  return ids.length > 0 ? ids : undefined
}

/**
 * Recover the loop root from inbound history, making the id inheritable with no
 * per-request state.
 *
 * The root is the message at the start of the trailing tool loop
 * (`findActiveToolLoopStart`). If that message is not an assistant turn carrying
 * tool uses — e.g. compaction removed the root — the loop identity is refused
 * and the caller takes a safe miss rather than attaching to another loop.
 */
export function deriveInheritedLoopId(messages: unknown): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  const loopStart = findActiveToolLoopStart(messages)
  if (loopStart >= messages.length) return undefined
  const ids = assistantToolUseIds(messages[loopStart])
  if (!ids) return undefined
  return loopIdFromToolUseIds(ids)
}

export type LoopAction = 'publish' | 'teardown' | 'none'

export interface ResolvedLoop {
  loopId?: string
  action: LoopAction
}

/**
 * §6.3's decision table, verbatim.
 *
 * | tool calls emitted, no inherited id | created from the emitted ids | publish  |
 * | tool calls emitted, inherited id    | the inherited id             | publish  |
 * | final no-tool response, inherited   | the inherited id             | teardown |
 * | no inherited id and no tool calls   | undefined                    | none     |
 */
export function resolveLoop(
  inheritedLoopId: string | undefined,
  emittedToolUses: readonly EmittedToolUse[]
): ResolvedLoop {
  if (emittedToolUses.length > 0) {
    // §6.3 hard refusal: an empty tool id cannot be matched back on the next
    // turn, so the turn is uncacheable regardless of an inherited identity.
    const emittedRootId = loopIdFromEmittedToolUses(emittedToolUses)
    if (emittedRootId === undefined) return { action: 'none' }
    return { loopId: inheritedLoopId ?? emittedRootId, action: 'publish' }
  }
  if (inheritedLoopId !== undefined) return { loopId: inheritedLoopId, action: 'teardown' }
  return { action: 'none' }
}
