import { describe, expect, test } from 'bun:test'
import { estimateTokens, parseEventStream } from '../plugin/response.js'

describe('estimateTokens', () => {
  test('ceil(length / 4)', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1) // ceil(1/4)
    expect(estimateTokens('abcd')).toBe(1) // ceil(4/4)
    expect(estimateTokens('abcde')).toBe(2) // ceil(5/4)
    expect(estimateTokens('a'.repeat(40))).toBe(10)
  })
})

describe('parseEventStream', () => {
  test('concatenates content event chunks into the response text', () => {
    // AWS event-stream frames the parser scans for: objects starting with {"content":
    const raw = '{"content":"Hello, "}{"content":"world"}'
    const result = parseEventStream(raw)
    expect(result.content).toBe('Hello, world')
    expect(result.toolCalls).toEqual([])
    // no tool use and no explicit stop => end_turn
    expect(result.stopReason).toBe('end_turn')
  })

  test('collects a tool use event and parses its JSON input', () => {
    const raw =
      '{"content":"before"}{"name":"read_file","toolUseId":"tid-1","input":"{\\"path\\":\\"/a.txt\\"}"}'
    const result = parseEventStream(raw)
    expect(result.content).toBe('before')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]!.toolUseId).toBe('tid-1')
    expect(result.toolCalls[0]!.name).toBe('read_file')
    expect(result.toolCalls[0]!.input).toEqual({ path: '/a.txt' })
    // presence of a tool call => stopReason tool_use
    expect(result.stopReason).toBe('tool_use')
  })

  test('leaves non-JSON tool input as the raw string', () => {
    const raw = '{"name":"do_thing","toolUseId":"tid-2","input":"not json"}'
    const result = parseEventStream(raw)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]!.input).toBe('not json')
  })

  test('explicit stop event marks stopReason tool_use', () => {
    const raw = '{"name":"t","toolUseId":"x","input":"{}"}{"stop":true}'
    const result = parseEventStream(raw)
    expect(result.stopReason).toBe('tool_use')
    expect(result.toolCalls[0]!.input).toEqual({})
  })

  test('empty input yields empty content and end_turn', () => {
    const result = parseEventStream('')
    expect(result.content).toBe('')
    expect(result.toolCalls).toEqual([])
    expect(result.stopReason).toBe('end_turn')
  })

  test('contextUsage event computes input/output tokens against the model window', () => {
    // 200000 (non-long-context) * 10% = 20000 total tokens.
    // content "abcd" => estimateTokens = ceil(4/4) = 1 output token.
    // input = max(0, 20000 - 1) = 19999.
    const raw = '{"content":"abcd"}{"contextUsagePercentage":10}'
    const result = parseEventStream(raw, 'claude-sonnet-4.5')
    expect(result.outputTokens).toBe(1)
    expect(result.inputTokens).toBe(19999)
  })

  test('no contextUsage => token counts are undefined', () => {
    const result = parseEventStream('{"content":"hi"}', 'claude-sonnet-4.5')
    expect(result.inputTokens).toBeUndefined()
    expect(result.outputTokens).toBeUndefined()
  })

  test('recovers a bracket-dialect tool call from the raw response', () => {
    const raw = '[Called search with args:{"q":"x"}]'
    const result = parseEventStream(raw)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]!.name).toBe('search')
    expect(result.toolCalls[0]!.input).toEqual({ q: 'x' })
    expect(result.content).not.toContain('[Called')
  })
})
