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

describe('ExactReplayMatcher chunk-boundary independence', () => {
  test('catches up on one char per chunk and releases only the trailing suffix chars', () => {
    // Given
    const matcher = new ExactReplayMatcher(TEXT_PREFIX)
    const replayed = 'hello world!?'

    // When
    const results = [...replayed].map((character) => matcher.consume(chunk({ content: character })))

    // Then
    expect(results.slice(0, 10).every((result) => result.kind === 'withheld')).toBe(true)
    expect(released(results[10]!)).toEqual([])
    expect(contentOf(released(results[11]!)[0], 'content')).toBe('!')
    expect(contentOf(released(results[12]!)[0], 'content')).toBe('?')
    expect(matcher.progress().matchedVisibleChars).toBe(11)
  })

  test('catches up when the whole reply arrives as one giant chunk', () => {
    // Given
    const matcher = new ExactReplayMatcher(TEXT_PREFIX)

    // When
    const result = matcher.consume(chunk({ content: 'hello world and then some more' }))

    // Then
    const suffix = released(result)
    expect(suffix).toHaveLength(1)
    expect(contentOf(suffix[0], 'content')).toBe(' and then some more')
    expect(matcher.progress().matchedVisibleChars).toBe(11)
  })

  test('matches CJK text split at boundaries the first attempt never used', () => {
    // Given
    const matcher = new ExactReplayMatcher({
      reasoningText: '',
      visibleText: '你好，世界',
      toolUses: []
    })

    // When
    const first = matcher.consume(chunk({ content: '你好' }))
    const second = matcher.consume(chunk({ content: '，世' }))
    const third = matcher.consume(chunk({ content: '界！' }))

    // Then
    expect([first, second].every((result) => result.kind === 'withheld')).toBe(true)
    expect(contentOf(released(third)[0], 'content')).toBe('！')
    expect(matcher.progress().matchedVisibleChars).toBe(5)
  })

  test('matches an emoji whose surrogate pair is split across two replay chunks', () => {
    // Given: the matcher compares JS string chars, i.e. UTF-16 code units, so a
    // lone high surrogate is a legal intermediate state rather than a mismatch.
    const emoji = '😀'
    expect(emoji.length).toBe(2)
    const matcher = new ExactReplayMatcher({
      reasoningText: '',
      visibleText: `ok${emoji}`,
      toolUses: []
    })

    // When
    const head = matcher.consume(chunk({ content: `ok${emoji[0]}` }))
    const tail = matcher.consume(chunk({ content: `${emoji[1]}done` }))

    // Then
    expect(head).toEqual({ kind: 'withheld' })
    expect(matcher.progress().matchedVisibleChars).toBe(4)
    expect(contentOf(released(tail)[0], 'content')).toBe('done')
  })

  test('reports a mismatch inside a multibyte character as a text divergence', () => {
    // Given
    const matcher = new ExactReplayMatcher({
      reasoningText: '',
      visibleText: '你好，世界',
      toolUses: []
    })

    // When
    const result = matcher.consume(chunk({ content: '你好，宇宙' }))

    // Then
    expect(result).toEqual({ kind: 'diverged', channel: 'text' })
    expect(matcher.progress().matchedVisibleChars).toBe(3)
  })
})

describe('ExactReplayMatcher tool channel divergence', () => {
  const ONE_TOOL: ReplayPrefix = {
    reasoningText: '',
    visibleText: '',
    toolUses: [{ toolUseId: 'tool-1', name: 'read', argumentsJson: '{"path":"/a"}' }]
  }

  function call(
    id: string,
    name: string | undefined,
    argumentsJson: string | undefined,
    index = 0
  ): unknown {
    const fn: Record<string, unknown> = {}
    if (name !== undefined) fn['name'] = name
    if (argumentsJson !== undefined) fn['arguments'] = argumentsJson
    return { index, id, function: fn }
  }

  test('rejects a replayed tool whose id changed', () => {
    // Given
    const matcher = new ExactReplayMatcher(ONE_TOOL)

    // When
    const result = matcher.consume(chunk({ tool_calls: [call('tool-9', 'read', '{"path":"/a"}')] }))

    // Then
    expect(result).toEqual({ kind: 'diverged', channel: 'tool' })
    expect(matcher.progress().matchedToolCount).toBe(0)
  })

  test('rejects a replayed tool whose name changed', () => {
    // Given
    const matcher = new ExactReplayMatcher(ONE_TOOL)

    // When
    const result = matcher.consume(
      chunk({ tool_calls: [call('tool-1', 'write', '{"path":"/a"}')] })
    )

    // Then
    expect(result).toEqual({ kind: 'diverged', channel: 'tool' })
  })

  test('withholds a still-streaming argument prefix and only diverges at the terminal chunk', () => {
    // Given
    const matcher = new ExactReplayMatcher(ONE_TOOL)

    // When: an argument delta that is a legal prefix of nothing yet cannot be
    // judged mid-stream, so the matcher waits instead of guessing.
    const partial = matcher.consume(chunk({ tool_calls: [call('tool-1', 'read', '{"path":')] }))
    const wrong = matcher.consume(chunk({ tool_calls: [call('tool-1', undefined, '"/b"}')] }))
    const terminal = matcher.consume(chunk({}, 'tool_calls'))

    // Then
    expect(partial).toEqual({ kind: 'withheld' })
    expect(wrong).toEqual({ kind: 'withheld' })
    expect(terminal).toEqual({ kind: 'diverged', channel: 'tool' })
    expect(matcher.progress().matchedToolCount).toBe(0)
  })

  test('catches up once a chunked argument stream reassembles the same normalized JSON', () => {
    // Given
    const matcher = new ExactReplayMatcher(ONE_TOOL)

    // When
    const opening = matcher.consume(chunk({ tool_calls: [call('tool-1', 'read', '{ "path"')] }))
    const closing = matcher.consume(chunk({ tool_calls: [call('tool-1', undefined, ': "/a" }')] }))

    // Then
    expect(opening).toEqual({ kind: 'withheld' })
    expect(closing).toEqual({ kind: 'release', chunks: [], caughtUp: true })
    expect(matcher.progress().matchedToolCount).toBe(1)
  })

  test('rejects an extra replayed tool that appears before the known prefix completes', () => {
    // Given
    const matcher = new ExactReplayMatcher(ONE_TOOL)

    // When
    const result = matcher.consume(
      chunk({
        tool_calls: [call('tool-1', 'read', '{"path":'), call('tool-2', 'write', '{}', 1)]
      })
    )

    // Then
    expect(result).toEqual({ kind: 'diverged', channel: 'tool' })
  })

  test('releases a genuinely new tool call once the delivered tool prefix matched', () => {
    // Given
    const matcher = new ExactReplayMatcher(ONE_TOOL)

    // When
    const result = matcher.consume(
      chunk({
        tool_calls: [call('tool-1', 'read', '{"path":"/a"}'), call('tool-2', 'write', '{}', 1)]
      })
    )

    // Then
    const suffix = released(result)
    expect(suffix).toHaveLength(1)
    expect(JSON.stringify(suffix[0])).toContain('tool-2')
    expect(JSON.stringify(suffix[0])).not.toContain('tool-1')
  })
})
