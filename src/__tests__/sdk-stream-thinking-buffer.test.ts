import { describe, expect, test } from 'bun:test'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'

// transformSdkStream always sets thinkingRequested = true, so any
// assistantResponseEvent.content that contains literal <thinking>...</thinking>
// tags is routed through the tag-splitting buffer path (NOT the
// reasoningContentEvent path). These tests exercise that buffer machinery:
// tag boundaries split across chunks, partial-tag holdback, the trailing \n\n
// strip, and the finalize remainder for an unclosed thinking block.

function makeSdkResponse(events: any[]): any {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const e of events) yield e
    })()
  }
}

async function collectChunks(
  events: any[],
  model = 'auto',
  convId = 'chatcmpl-test'
): Promise<any[]> {
  const chunks: any[] = []
  for await (const chunk of transformSdkStream(makeSdkResponse(events), model, convId)) {
    chunks.push(chunk)
  }
  return chunks
}

function reasoningTextOf(chunk: any): string | undefined {
  return chunk?.choices?.[0]?.delta?.reasoning_content
}

function contentTextOf(chunk: any): string | undefined {
  return chunk?.choices?.[0]?.delta?.content
}

function reasoningOf(chunks: any[]): string {
  return chunks
    .map((c) => reasoningTextOf(c))
    .filter((s): s is string => s !== undefined)
    .join('')
}

function contentOf(chunks: any[]): string {
  return chunks
    .map((c) => contentTextOf(c))
    .filter((s): s is string => s !== undefined)
    .join('')
}

function toolCallStarts(chunks: any[]): any[] {
  return chunks.filter((c) => {
    const tc = c?.choices?.[0]?.delta?.tool_calls?.[0]
    return tc && tc.type === 'function' && tc.id !== undefined
  })
}

describe('transformSdkStream <thinking> tag buffer path', () => {
  test('complete <thinking>...</thinking> in one chunk: reasoning extracted, trailing text streamed', async () => {
    const events = [
      { assistantResponseEvent: { content: '<thinking>plan the work</thinking>the reply' } }
    ]
    const chunks = await collectChunks(events)

    expect(reasoningOf(chunks)).toBe('plan the work')
    expect(contentOf(chunks)).toBe('the reply')
  })

  test('text BEFORE <thinking> is streamed as content, then thinking is extracted', async () => {
    const events = [
      {
        assistantResponseEvent: {
          content: 'intro text <thinking>hidden reasoning</thinking>final'
        }
      }
    ]
    const chunks = await collectChunks(events)

    // "intro text " comes before the <thinking> tag and must be visible content.
    expect(contentOf(chunks)).toBe('intro text final')
    expect(reasoningOf(chunks)).toBe('hidden reasoning')
  })

  test('start tag split across chunks: "<thin" + "king>secret</thinking>visible"', async () => {
    const events = [
      { assistantResponseEvent: { content: 'pre <thin' } },
      { assistantResponseEvent: { content: 'king>secret</thinking>visible' } }
    ]
    const chunks = await collectChunks(events)

    // The partial "<thin" tail is held back (safeLen path) until the tag
    // completes, so it is NEVER leaked as visible content.
    const content = contentOf(chunks)
    expect(content).not.toContain('<thin')
    expect(content).toBe('pre visible')
    expect(reasoningOf(chunks)).toBe('secret')
  })

  test('end tag split across chunks: "</thin" boundary holdback then completion', async () => {
    const events = [
      { assistantResponseEvent: { content: '<thinking>reasoning part one </thin' } },
      { assistantResponseEvent: { content: 'king>reply part' } }
    ]
    const chunks = await collectChunks(events)

    const reasoning = reasoningOf(chunks)
    // The "</thin" tail must not appear inside reasoning; it is held until
    // the end tag completes on the next chunk.
    expect(reasoning).not.toContain('</thin')
    expect(reasoning).toBe('reasoning part one ')
    expect(contentOf(chunks)).toBe('reply part')
  })

  test('trailing \\n\\n after </thinking> is stripped before visible text', async () => {
    const events = [
      { assistantResponseEvent: { content: '<thinking>x</thinking>\n\nvisible after strip' } }
    ]
    const chunks = await collectChunks(events)

    expect(reasoningOf(chunks)).toBe('x')
    // The two leading newlines that Kiro inserts after </thinking> are removed.
    expect(contentOf(chunks)).toBe('visible after strip')
  })

  test('unclosed <thinking> at stream end: finalize flushes buffered reasoning (inThinking branch)', async () => {
    const events = [
      { assistantResponseEvent: { content: '<thinking>reasoning that never ' } },
      { assistantResponseEvent: { content: 'closes properly' } }
    ]
    const chunks = await collectChunks(events)

    // No </thinking> ever arrives. The finalize inThinking branch flushes the
    // remaining buffer as reasoning and stops the thinking block.
    const reasoning = reasoningOf(chunks)
    expect(reasoning).toContain('reasoning that never')
    expect(reasoning).toContain('closes properly')
    expect(contentOf(chunks)).toBe('')
  })

  test('plain text with no tags streams as content through the buffer (safeLen tail flush at finalize)', async () => {
    const events = [{ assistantResponseEvent: { content: 'just a normal answer' } }]
    const chunks = await collectChunks(events)

    // With no thinking tag ever seen, the buffered safe-tail is flushed via the
    // finalize !inThinking branch and appears as visible content.
    expect(contentOf(chunks)).toBe('just a normal answer')
    expect(reasoningOf(chunks)).toBe('')
  })

  test('content after thinkingExtracted streams directly (thinkingExtracted branch)', async () => {
    const events = [
      { assistantResponseEvent: { content: '<thinking>done</thinking>first' } },
      { assistantResponseEvent: { content: ' second' } },
      { assistantResponseEvent: { content: ' third' } }
    ]
    const chunks = await collectChunks(events)

    expect(reasoningOf(chunks)).toBe('done')
    // After the thinking block is extracted, subsequent chunks route through the
    // thinkingExtracted fast path.
    expect(contentOf(chunks)).toBe('first second third')
  })
})

describe('transformSdkStream reasoning + tool-use combinations', () => {
  test('reasoningContentEvent then toolUseEvent: reasoning emitted, structured tool call produced', async () => {
    const events = [
      { reasoningContentEvent: { text: 'I should search' } },
      { toolUseEvent: { name: 'grep', toolUseId: 'tool-1', input: '{"q":"cat"}', stop: true } }
    ]
    const chunks = await collectChunks(events)

    expect(reasoningOf(chunks)).toBe('I should search')

    const starts = toolCallStarts(chunks)
    expect(starts.length).toBe(1)
    expect(starts[0].choices[0].delta.tool_calls[0].function.name).toBe('grep')
    // First (and only) tool call must have ordinal index 0.
    expect(starts[0].choices[0].delta.tool_calls[0].index).toBe(0)
  })

  test('toolUseEvent streamed in fragments (same toolUseId) accumulates input', async () => {
    const events = [
      { toolUseEvent: { name: 'write', toolUseId: 'tid', input: '{"path":"a",' } },
      { toolUseEvent: { name: 'write', toolUseId: 'tid', input: '"content":"b"}' } },
      { toolUseEvent: { name: 'write', toolUseId: 'tid', input: '', stop: true } }
    ]
    const chunks = await collectChunks(events)

    const starts = toolCallStarts(chunks)
    expect(starts.length).toBe(1)
    // The accumulated JSON input is re-serialized and emitted as arguments.
    const argChunks = chunks
      .map((c) => c?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments)
      .filter((s): s is string => s !== undefined && s !== '')
    const joined = argChunks.join('')
    expect(joined).toContain('"path":"a"')
    expect(joined).toContain('"content":"b"')
  })

  test('two distinct tool calls get ordinals 0 and 1', async () => {
    const events = [
      { toolUseEvent: { name: 'read', toolUseId: 't0', input: '{"p":"1"}', stop: true } },
      { toolUseEvent: { name: 'read', toolUseId: 't1', input: '{"p":"2"}', stop: true } }
    ]
    const chunks = await collectChunks(events)

    const starts = toolCallStarts(chunks)
    expect(starts.length).toBe(2)
    expect(starts[0].choices[0].delta.tool_calls[0].index).toBe(0)
    expect(starts[1].choices[0].delta.tool_calls[0].index).toBe(1)
  })

  test('tool call with unparseable input falls back to raw string arguments', async () => {
    const events = [{ toolUseEvent: { name: 'x', toolUseId: 't', input: 'not-json{', stop: true } }]
    const chunks = await collectChunks(events)

    const argChunks = chunks
      .map((c) => c?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments)
      .filter((s): s is string => s !== undefined && s !== '')
    expect(argChunks.join('')).toBe('not-json{')
  })
})

describe('transformSdkStream dialect-gate interplay with thinking', () => {
  test('dialect tool call after </thinking>: reasoning kept, dialect suppressed and structured', async () => {
    const events = [
      { assistantResponseEvent: { content: '<thinking>decide</thinking>Let me read. ' } },
      { assistantResponseEvent: { content: '<invoke name="read"><parameter name="path">/x' } },
      { assistantResponseEvent: { content: '</parameter></invoke>' } }
    ]
    const chunks = await collectChunks(events)

    expect(reasoningOf(chunks)).toBe('decide')

    const content = contentOf(chunks)
    // The dialect span must never leak into visible content.
    expect(content).not.toContain('<invoke')
    expect(content).toContain('Let me read.')

    const starts = toolCallStarts(chunks)
    expect(starts.length).toBe(1)
    expect(starts[0].choices[0].delta.tool_calls[0].function.name).toBe('read')
  })

  test('finalize remainder: text after a dialect span is emitted (remainderText branch)', async () => {
    // Text appears AFTER a complete <invoke> span. The dialect gate withholds
    // everything from the marker on; at finalize, parseTextToolCalls strips the
    // span and returns the trailing text as remainderText, which must be emitted.
    const events = [
      { assistantResponseEvent: { content: 'A ' } },
      {
        assistantResponseEvent: {
          content: '<invoke name="ls"><parameter name="p">.</parameter></invoke> tail text'
        }
      }
    ]
    const chunks = await collectChunks(events)

    const content = contentOf(chunks)
    expect(content).not.toContain('<invoke')
    expect(content).toContain('A ')
    // Trailing text recovered at finalization.
    expect(content).toContain('tail text')

    expect(toolCallStarts(chunks).length).toBe(1)
  })
})

describe('transformSdkStream metadata / context usage', () => {
  test('metadataEvent.contextUsagePercentage feeds message_delta usage input_tokens', async () => {
    const events = [
      { assistantResponseEvent: { content: 'hello world answer' } },
      { metadataEvent: { contextUsagePercentage: 10 } }
    ]
    const chunks = await collectChunks(events, 'claude-sonnet-4-5')

    const usageChunk = chunks.find((c) => c.usage !== undefined)
    expect(usageChunk).toBeDefined()
    // 200000 * 10% = 20000 total; minus output tokens => positive input tokens.
    expect(usageChunk.usage.prompt_tokens).toBeGreaterThan(0)
    expect(usageChunk.usage.total_tokens).toBeGreaterThan(usageChunk.usage.completion_tokens)
  })

  test('contextUsageEvent (alternate shape) also sets context usage', async () => {
    const events = [
      { assistantResponseEvent: { content: 'text' } },
      { contextUsageEvent: { contextUsagePercentage: 5 } }
    ]
    const chunks = await collectChunks(events, 'claude-sonnet-4-5')

    const usageChunk = chunks.find((c) => c.usage !== undefined)
    expect(usageChunk).toBeDefined()
    expect(usageChunk.usage.prompt_tokens).toBeGreaterThan(0)
  })

  test('no context usage: input_tokens stays 0', async () => {
    const events = [{ assistantResponseEvent: { content: 'text only' } }]
    const chunks = await collectChunks(events)

    const usageChunk = chunks.find((c) => c.usage !== undefined)
    expect(usageChunk).toBeDefined()
    expect(usageChunk.usage.prompt_tokens).toBe(0)
  })

  test('finish_reason is tool_calls when a tool call is present, else stop', async () => {
    const withTool = await collectChunks([
      { toolUseEvent: { name: 'x', toolUseId: 't', input: '{}', stop: true } }
    ])
    const finishTool = withTool.find((c) => c?.choices?.[0]?.finish_reason)
    expect(finishTool.choices[0].finish_reason).toBe('tool_calls')

    const noTool = await collectChunks([{ assistantResponseEvent: { content: 'hi' } }])
    const finishStop = noTool.find((c) => c?.choices?.[0]?.finish_reason)
    expect(finishStop.choices[0].finish_reason).toBe('stop')
  })
})

describe('transformSdkStream error path', () => {
  test('missing event stream throws', async () => {
    await expect(async () => {
      for await (const _ of transformSdkStream({}, 'auto', 'id')) {
        // no-op
      }
    }).toThrow('SDK response has no event stream')
  })
})
