import { describe, expect, test } from 'bun:test'
import {
  ExactReplayMatcher,
  type ReplayMatchResult,
  type ReplayPrefix
} from '../core/request/replay-matcher.js'

function chunk(
  delta: Readonly<Record<string, unknown>>,
  finishReason: string | null = null
): unknown {
  return { choices: [{ delta, finish_reason: finishReason }] }
}

function released(result: ReplayMatchResult): readonly unknown[] {
  expect(result.kind).toBe('release')
  return result.kind === 'release' ? result.chunks : []
}

function contentOf(value: unknown, field: 'content' | 'reasoning_content'): string | undefined {
  if (typeof value !== 'object' || value === null || !('choices' in value)) return undefined
  const choices = value.choices
  if (!Array.isArray(choices)) return undefined
  const first = choices[0]
  if (typeof first !== 'object' || first === null || !('delta' in first)) return undefined
  const delta = first.delta
  if (typeof delta !== 'object' || delta === null || !(field in delta)) return undefined
  const content = delta[field]
  return typeof content === 'string' ? content : undefined
}

const TEXT_PREFIX: ReplayPrefix = {
  reasoningText: '',
  visibleText: 'hello world',
  toolUses: []
}

describe('ExactReplayMatcher', () => {
  test('catches up across different text chunk boundaries and releases only the suffix', () => {
    // Given
    const matcher = new ExactReplayMatcher(TEXT_PREFIX)

    // When
    const first = matcher.consume(chunk({ content: 'hel' }))
    const second = matcher.consume(chunk({ content: 'lo world!' }))

    // Then
    expect(first).toEqual({ kind: 'withheld' })
    const suffix = released(second)
    expect(suffix).toHaveLength(1)
    expect(contentOf(suffix[0], 'content')).toBe('!')
    expect(matcher.progress()).toEqual({
      matchedReasoningChars: 0,
      matchedVisibleChars: 11,
      matchedToolCount: 0
    })
  })

  test('withholds suffix chunks until every independent channel catches up', () => {
    // Given
    const matcher = new ExactReplayMatcher({
      reasoningText: 'think',
      visibleText: 'answer',
      toolUses: []
    })

    // When
    const text = matcher.consume(chunk({ content: 'answer+' }))
    const reasoning = matcher.consume(chunk({ reasoning_content: 'think?' }))

    // Then
    expect(text).toEqual({ kind: 'withheld' })
    const suffix = released(reasoning)
    expect(suffix).toHaveLength(2)
    expect(contentOf(suffix[0], 'content')).toBe('+')
    expect(contentOf(suffix[1], 'reasoning_content')).toBe('?')
  })

  test('rejects a reasoning or text byte mismatch without releasing buffered output', () => {
    // Given
    const reasoningMatcher = new ExactReplayMatcher({
      reasoningText: 'expected',
      visibleText: '',
      toolUses: []
    })
    const textMatcher = new ExactReplayMatcher(TEXT_PREFIX)

    // When
    const reasoning = reasoningMatcher.consume(chunk({ reasoning_content: 'expectXd' }))
    const text = textMatcher.consume(chunk({ content: 'hello wurld' }))

    // Then
    expect(reasoning).toEqual({ kind: 'diverged', channel: 'reasoning' })
    expect(text).toEqual({ kind: 'diverged', channel: 'text' })
    expect(reasoningMatcher.progress().matchedReasoningChars).toBe(6)
    expect(textMatcher.progress().matchedVisibleChars).toBe(7)
  })

  test('normalizes tool arguments while preserving ordered id and name matching', () => {
    // Given
    const prefix: ReplayPrefix = {
      reasoningText: '',
      visibleText: '',
      toolUses: [
        { toolUseId: 'tool-1', name: 'read', argumentsJson: '{"path":"/a"}' },
        { toolUseId: 'tool-2', name: 'write', argumentsJson: '{"path":"/b"}' }
      ]
    }
    const matching = new ExactReplayMatcher(prefix)
    const reordered = new ExactReplayMatcher(prefix)
    const matchingCalls = [
      { index: 0, id: 'tool-1', function: { name: 'read', arguments: '{ "path": "/a" }' } },
      { index: 1, id: 'tool-2', function: { name: 'write', arguments: '{"path":"/b"}' } }
    ]

    // When
    const caughtUp = matching.consume(chunk({ tool_calls: matchingCalls }))
    const diverged = reordered.consume(chunk({ tool_calls: [matchingCalls[1], matchingCalls[0]] }))

    // Then
    expect(caughtUp).toEqual({ kind: 'release', chunks: [], caughtUp: true })
    expect(diverged).toEqual({ kind: 'diverged', channel: 'tool' })
  })

  test('treats a terminal chunk before full prefix coverage as an early-end divergence', () => {
    // Given
    const matcher = new ExactReplayMatcher(TEXT_PREFIX)
    matcher.consume(chunk({ content: 'hello' }))

    // When
    const result = matcher.consume(chunk({}, 'stop'))

    // Then
    expect(result).toEqual({ kind: 'diverged', channel: 'early_end' })
    expect(matcher.progress().matchedVisibleChars).toBe(5)
  })
})
