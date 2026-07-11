import { describe, expect, test } from 'bun:test'
import { findRealTag, parseStreamBuffer } from '../plugin/streaming/stream-parser.js'
import { transformKiroStream } from '../plugin/streaming/stream-transformer.js'

// The raw Kiro event-stream path: parseStreamBuffer scans a byte buffer for the
// embedded JSON event objects Kiro emits ({"content":...}, {"name":...,"toolUseId":...},
// {"input":...}, {"stop":...}, {"contextUsagePercentage":...}), and transformKiroStream
// turns a streamed Response body of those bytes into OpenAI chunks.

function bodyFrom(str: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(str))
      controller.close()
    }
  })
  return new Response(stream)
}

function bodyFromChunks(parts: string[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p))
      controller.close()
    }
  })
  return new Response(stream)
}

async function collect(response: Response, model = 'auto', convId = 'c1'): Promise<any[]> {
  const chunks: any[] = []
  for await (const chunk of transformKiroStream(response, model, convId)) {
    chunks.push(chunk)
  }
  return chunks
}

function contentOf(chunks: any[]): string {
  return chunks
    .map((c) => c?.choices?.[0]?.delta?.content)
    .filter((s): s is string => s !== undefined)
    .join('')
}

function reasoningOf(chunks: any[]): string {
  return chunks
    .map((c) => c?.choices?.[0]?.delta?.reasoning_content)
    .filter((s): s is string => s !== undefined)
    .join('')
}

function toolCallStarts(chunks: any[]): any[] {
  return chunks.filter((c) => {
    const tc = c?.choices?.[0]?.delta?.tool_calls?.[0]
    return tc && tc.type === 'function' && tc.id !== undefined
  })
}

describe('parseStreamBuffer: event extraction', () => {
  test('single content event parsed', () => {
    const { events, remaining } = parseStreamBuffer('{"content":"hello"}')
    expect(events).toEqual([{ type: 'content', data: 'hello' }])
    expect(remaining).toBe('')
  })

  test('toolUse event with name + toolUseId', () => {
    const { events } = parseStreamBuffer(
      '{"name":"grep","toolUseId":"t1","input":"{}","stop":true}'
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'toolUse',
      data: { name: 'grep', toolUseId: 't1', input: '{}', stop: true }
    })
  })

  test('toolUseInput event: input without name', () => {
    const { events } = parseStreamBuffer('{"input":"partial-json"}')
    expect(events).toEqual([{ type: 'toolUseInput', data: { input: 'partial-json' } }])
  })

  test('toolUseStop event: stop without contextUsage', () => {
    const { events } = parseStreamBuffer('{"stop":true}')
    expect(events).toEqual([{ type: 'toolUseStop', data: { stop: true } }])
  })

  test('contextUsage event parsed', () => {
    const { events } = parseStreamBuffer('{"contextUsagePercentage":42}')
    expect(events).toEqual([{ type: 'contextUsage', data: { contextUsagePercentage: 42 } }])
  })

  test('followupPrompt content is ignored (not a content event)', () => {
    const { events } = parseStreamBuffer('{"content":"x","followupPrompt":"more?"}')
    // content + followupPrompt => the content branch is skipped (!parsed.followupPrompt fails)
    expect(events).toHaveLength(0)
  })

  test('multiple events in one buffer parsed in order', () => {
    const { events, remaining } = parseStreamBuffer(
      '{"content":"a"}{"content":"b"}{"contextUsagePercentage":7}'
    )
    expect(events.map((e) => e.type)).toEqual(['content', 'content', 'contextUsage'])
    expect(events[0].data).toBe('a')
    expect(events[1].data).toBe('b')
    expect(remaining).toBe('')
  })

  test('incomplete trailing JSON after a complete event: complete parsed, remainder truncated to trailing substring quirk', () => {
    const { events, remaining } = parseStreamBuffer('{"content":"done"}{"content":"partial')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('done')
    // Counterintuitive but real: the final substring(searchStart) re-slices the
    // already-shortened remaining, so only the last char survives. Pinned so a
    // change to parseStreamBuffer's remainder handling fails loudly.
    expect(remaining).toBe('l')
  })

  test('a lone incomplete event with nothing complete before it is preserved intact', () => {
    const { events, remaining } = parseStreamBuffer('{"content":"partial fragment')
    expect(events).toHaveLength(0)
    expect(remaining).toBe('{"content":"partial fragment')
  })

  test('no recognizable event markers: no events, buffer preserved', () => {
    const { events } = parseStreamBuffer('plain text with no json markers')
    expect(events).toHaveLength(0)
  })

  test('escaped quotes inside string do not break brace matching', () => {
    const { events } = parseStreamBuffer('{"content":"he said \\"hi\\" to me"}')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('he said "hi" to me')
  })

  test('nested braces inside string value handled by brace counter', () => {
    const { events } = parseStreamBuffer('{"input":"{\\"nested\\":true}"}')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('toolUseInput')
    expect(events[0].data.input).toBe('{"nested":true}')
  })
})

describe('findRealTag: code-block aware tag detection', () => {
  test('finds tag outside code blocks', () => {
    expect(findRealTag('abc <thinking> def', '<thinking>')).toBe(4)
  })

  test('ignores tag inside a fenced code block, finds the real one after', () => {
    const buf = '```\n<thinking>\n```\nreal <thinking> here'
    const pos = findRealTag(buf, '<thinking>')
    // The first <thinking> sits inside the ``` fence and is skipped; the real
    // one after the fence is returned.
    expect(pos).toBeGreaterThan(buf.indexOf('```\n<thinking>\n```'))
    expect(buf.slice(pos, pos + 10)).toBe('<thinking>')
  })

  test('returns -1 when tag only appears inside a code block', () => {
    expect(findRealTag('```\n<thinking>\n```', '<thinking>')).toBe(-1)
  })

  test('returns -1 when tag absent', () => {
    expect(findRealTag('no tag at all', '<thinking>')).toBe(-1)
  })
})

describe('transformKiroStream: end-to-end raw stream', () => {
  test('null body throws', async () => {
    const resp = new Response(null)
    await expect(async () => {
      for await (const _ of transformKiroStream(resp, 'auto', 'c1')) {
        // no-op
      }
    }).toThrow('Response body is null')
  })

  test('plain content streams as visible text', async () => {
    const chunks = await collect(bodyFrom('{"content":"Hello "}{"content":"world"}'))
    expect(contentOf(chunks)).toBe('Hello world')
  })

  test('<thinking> tags split reasoning from content', async () => {
    const chunks = await collect(bodyFrom('{"content":"<thinking>reason</thinking>reply text"}'))
    expect(reasoningOf(chunks)).toBe('reason')
    expect(contentOf(chunks)).toBe('reply text')
  })

  test('content split across two body chunks reassembles', async () => {
    const chunks = await collect(bodyFromChunks(['{"content":"Hel', 'lo"}{"content":" there"}']))
    expect(contentOf(chunks)).toBe('Hello there')
  })

  test('tool use event emits structured tool call', async () => {
    const chunks = await collect(
      bodyFrom('{"name":"read","toolUseId":"t1","input":"{\\"path\\":\\"/x\\"}","stop":true}')
    )
    const starts = toolCallStarts(chunks)
    expect(starts.length).toBe(1)
    expect(starts[0].choices[0].delta.tool_calls[0].function.name).toBe('read')
    expect(starts[0].choices[0].delta.tool_calls[0].index).toBe(0)
  })

  test('tool use with separate input then stop events accumulates', async () => {
    const chunks = await collect(
      bodyFrom('{"name":"write","toolUseId":"t","input":"{\\"a\\":"}{"input":"1}"}{"stop":true}')
    )
    const starts = toolCallStarts(chunks)
    expect(starts.length).toBe(1)
    const args = chunks
      .map((c) => c?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments)
      .filter((s): s is string => s !== undefined && s !== '')
      .join('')
    expect(args).toContain('"a":1')
  })

  test('contextUsagePercentage produces positive prompt_tokens in usage', async () => {
    const chunks = await collect(
      bodyFrom('{"content":"some answer text"}{"contextUsagePercentage":10}'),
      'claude-sonnet-4-5'
    )
    const usageChunk = chunks.find((c) => c.usage !== undefined)
    expect(usageChunk).toBeDefined()
    expect(usageChunk.usage.prompt_tokens).toBeGreaterThan(0)
  })

  test('bracket-dialect tool call in content is parsed at finalize', async () => {
    const chunks = await collect(
      bodyFrom('{"content":"ok [Called search with args: {\\"q\\":\\"cats\\"}] done"}')
    )
    const starts = toolCallStarts(chunks)
    expect(starts.length).toBe(1)
    expect(starts[0].choices[0].delta.tool_calls[0].function.name).toBe('search')
  })

  test('finish_reason stop for text-only, tool_calls when tool present', async () => {
    const textOnly = await collect(bodyFrom('{"content":"hi"}'))
    expect(textOnly.find((c) => c?.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe(
      'stop'
    )

    const withTool = await collect(
      bodyFrom('{"name":"x","toolUseId":"t","input":"{}","stop":true}')
    )
    expect(withTool.find((c) => c?.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe(
      'tool_calls'
    )
  })

  test('unclosed <thinking> at end flushes buffered reasoning at finalize', async () => {
    const chunks = await collect(bodyFrom('{"content":"<thinking>never closes"}'))
    expect(reasoningOf(chunks)).toContain('never closes')
    expect(contentOf(chunks)).toBe('')
  })
})
