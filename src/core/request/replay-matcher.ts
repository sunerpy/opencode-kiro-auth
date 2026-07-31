import {
  EmittedOutputAccumulator,
  type EmittedToolUse
} from '../../plugin/reasoning/emitted-output.js'
import { normalizeToolArguments } from '../../plugin/reasoning/turn-identity.js'

export type ReplayPrefix = {
  readonly reasoningText: string
  readonly visibleText: string
  readonly toolUses: readonly EmittedToolUse[]
}

export type ReplayDivergenceChannel = 'reasoning' | 'text' | 'tool' | 'early_end' | 'none'

export type ReplayMatchProgress = {
  readonly matchedReasoningChars: number
  readonly matchedVisibleChars: number
  readonly matchedToolCount: number
}

export type ReplayMatchResult =
  | { readonly kind: 'withheld' }
  | { readonly kind: 'release'; readonly chunks: readonly unknown[]; readonly caughtUp: boolean }
  | { readonly kind: 'diverged'; readonly channel: Exclude<ReplayDivergenceChannel, 'none'> }

type ParsedChunk = {
  readonly record: Record<PropertyKey, unknown>
  readonly choices: readonly unknown[]
  readonly first: Record<PropertyKey, unknown>
  readonly delta: Record<PropertyKey, unknown>
  readonly content: string | undefined
  readonly reasoning: string | undefined
  readonly toolCalls: readonly unknown[]
  readonly terminal: boolean
}

type StringMatch =
  | { readonly kind: 'matched'; readonly offset: number; readonly suffix: string }
  | { readonly kind: 'diverged'; readonly offset: number }

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null
}

function parseChunk(chunk: unknown): ParsedChunk | undefined {
  if (!isRecord(chunk)) return undefined
  const choices = chunk['choices']
  if (!Array.isArray(choices)) return undefined
  const first = choices[0]
  if (!isRecord(first)) return undefined
  const delta = first['delta']
  if (!isRecord(delta)) return undefined
  const content = delta['content']
  const reasoning = delta['reasoning_content']
  const toolCalls = delta['tool_calls']
  const finishReason = first['finish_reason']
  return {
    record: chunk,
    choices,
    first,
    delta,
    content: typeof content === 'string' ? content : undefined,
    reasoning: typeof reasoning === 'string' ? reasoning : undefined,
    toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
    terminal: finishReason !== null && finishReason !== undefined
  }
}

function matchString(expected: string, offset: number, value: string | undefined): StringMatch {
  if (value === undefined || value.length === 0) return { kind: 'matched', offset, suffix: '' }
  const remaining = expected.slice(offset)
  const prefixLength = Math.min(remaining.length, value.length)
  let matchedLength = 0
  while (matchedLength < prefixLength && value[matchedLength] === remaining[matchedLength]) {
    matchedLength++
  }
  if (matchedLength < prefixLength) {
    return { kind: 'diverged', offset: offset + matchedLength }
  }
  return {
    kind: 'matched',
    offset: offset + prefixLength,
    suffix: value.slice(prefixLength)
  }
}

function toolIndex(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const index = value['index']
  return typeof index === 'number' ? index : undefined
}

function trimChunk(
  parsed: ParsedChunk,
  content: string,
  reasoning: string,
  toolCalls: readonly unknown[]
): unknown | undefined {
  const hasSuffix = content.length > 0 || reasoning.length > 0 || toolCalls.length > 0
  if (!hasSuffix && !parsed.terminal) return undefined

  const delta: Record<PropertyKey, unknown> = {}
  if (content.length > 0) delta['content'] = content
  if (reasoning.length > 0) delta['reasoning_content'] = reasoning
  if (toolCalls.length > 0) delta['tool_calls'] = toolCalls
  return {
    ...parsed.record,
    choices: [{ ...parsed.first, delta }, ...parsed.choices.slice(1)]
  }
}

/**
 * Matches one transformed replay against an already delivered three-channel prefix.
 * Mutation is intentional: this object is a per-attempt accumulator and publication gate.
 */
export class ExactReplayMatcher {
  private readonly prefix: ReplayPrefix
  private readonly expectedTools: readonly EmittedToolUse[]
  private readonly replayed = new EmittedOutputAccumulator()
  private readonly toolPositions = new Map<number, number>()
  private readonly bufferedSuffix: unknown[] = []
  private reasoningOffset = 0
  private visibleOffset = 0
  private matchedTools = 0
  private caughtUp = false
  private divergence: Exclude<ReplayDivergenceChannel, 'none'> | undefined

  constructor(prefix: ReplayPrefix) {
    this.prefix = prefix
    this.expectedTools = prefix.toolUses.map((tool) => ({
      toolUseId: tool.toolUseId,
      name: tool.name,
      argumentsJson: normalizeToolArguments(tool.argumentsJson)
    }))
  }

  consume(chunk: unknown): ReplayMatchResult {
    if (this.divergence) return { kind: 'diverged', channel: this.divergence }
    if (this.caughtUp) return { kind: 'release', chunks: [chunk], caughtUp: false }

    const parsed = parseChunk(chunk)
    if (!parsed) return { kind: 'withheld' }
    const reasoning = matchString(this.prefix.reasoningText, this.reasoningOffset, parsed.reasoning)
    this.reasoningOffset = reasoning.offset
    if (reasoning.kind === 'diverged') return this.diverge('reasoning')
    const visible = matchString(this.prefix.visibleText, this.visibleOffset, parsed.content)
    this.visibleOffset = visible.offset
    if (visible.kind === 'diverged') return this.diverge('text')

    for (const call of parsed.toolCalls) {
      const index = toolIndex(call)
      if (index !== undefined && !this.toolPositions.has(index)) {
        this.toolPositions.set(index, this.toolPositions.size)
      }
    }
    this.replayed.observeChunk(chunk)
    const replayedTools = this.replayed.toolUses()
    const toolDiverged = this.matchTools(replayedTools, parsed.terminal)
    if (toolDiverged) return this.diverge('tool')

    const suffixTools = parsed.toolCalls.filter((call) => {
      const index = toolIndex(call)
      if (index === undefined) return false
      const position = this.toolPositions.get(index)
      return position !== undefined && position >= this.expectedTools.length
    })
    const suffix = trimChunk(parsed, visible.suffix, reasoning.suffix, suffixTools)
    if (!this.channelsCaughtUp()) {
      if (parsed.terminal) return this.diverge('early_end')
      if (suffix !== undefined) this.bufferedSuffix.push(suffix)
      return { kind: 'withheld' }
    }

    this.caughtUp = true
    const chunks = [...this.bufferedSuffix]
    this.bufferedSuffix.length = 0
    if (suffix !== undefined) chunks.push(suffix)
    return { kind: 'release', chunks, caughtUp: true }
  }

  progress(): ReplayMatchProgress {
    return {
      matchedReasoningChars: this.reasoningOffset,
      matchedVisibleChars: this.visibleOffset,
      matchedToolCount: this.matchedTools
    }
  }

  private matchTools(replayed: readonly EmittedToolUse[], terminal: boolean): boolean {
    let matched = 0
    const compared = Math.min(replayed.length, this.expectedTools.length)
    for (let index = 0; index < compared; index++) {
      const actual = replayed[index]
      const expected = this.expectedTools[index]
      if (!actual || !expected) return true
      if (actual.toolUseId !== expected.toolUseId || actual.name !== expected.name) return true
      if (normalizeToolArguments(actual.argumentsJson) !== expected.argumentsJson) break
      matched++
    }
    this.matchedTools = matched
    if (replayed.length > this.expectedTools.length && matched < this.expectedTools.length) {
      return true
    }
    return terminal && matched < this.expectedTools.length
  }

  private channelsCaughtUp(): boolean {
    return (
      this.reasoningOffset === this.prefix.reasoningText.length &&
      this.visibleOffset === this.prefix.visibleText.length &&
      this.matchedTools === this.expectedTools.length
    )
  }

  private diverge(
    channel: Exclude<ReplayDivergenceChannel, 'none'>
  ): Extract<ReplayMatchResult, { readonly kind: 'diverged' }> {
    this.divergence = channel
    this.bufferedSuffix.length = 0
    return { kind: 'diverged', channel }
  }
}
