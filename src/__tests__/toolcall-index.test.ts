import { describe, expect, test } from 'bun:test'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'
import { transformKiroStream } from '../plugin/streaming/stream-transformer.js'

function makeSdkResponse(events: any[]): any {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const e of events) yield e
    })()
  }
}

async function collectSdkChunks(
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

function makeRawResponse(rawWire: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(rawWire))
      controller.close()
    }
  })
  return new Response(body)
}

async function collectRawChunks(
  rawWire: string,
  model = 'auto',
  convId = 'chatcmpl-test'
): Promise<any[]> {
  const chunks: any[] = []
  for await (const chunk of transformKiroStream(makeRawResponse(rawWire), model, convId)) {
    chunks.push(chunk)
  }
  return chunks
}

function toolStartChunks(chunks: any[]): any[] {
  return chunks.filter((c) => {
    const tc = c?.choices?.[0]?.delta?.tool_calls?.[0]
    return tc && tc.type === 'function' && tc.id !== undefined
  })
}

function reasoningTextOf(chunk: any): string | undefined {
  return chunk?.choices?.[0]?.delta?.reasoning_content
}

function contentTextOf(chunk: any): string | undefined {
  return chunk?.choices?.[0]?.delta?.content
}

describe('tool-call index is 0-based ordinal (SDK path)', () => {
  test('reasoning + text + 2 tools: indices are 0 and 1, not offset by blocks', async () => {
    const events = [
      { reasoningContentEvent: { text: 'thinking' } },
      { assistantResponseEvent: { content: 'ok' } },
      { toolUseEvent: { name: 't1', toolUseId: 'id1', input: '{"a":1}', stop: true } },
      { toolUseEvent: { name: 't2', toolUseId: 'id2', input: '{"b":2}', stop: true } }
    ]

    const chunks = await collectSdkChunks(events)

    const starts = toolStartChunks(chunks)
    expect(starts.length).toBe(2)

    const first = starts.find((c) => c.choices[0].delta.tool_calls[0].id === 'id1')
    const second = starts.find((c) => c.choices[0].delta.tool_calls[0].id === 'id2')
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first.choices[0].delta.tool_calls[0].index).toBe(0)
    expect(second.choices[0].delta.tool_calls[0].index).toBe(1)

    const reasoning = chunks
      .filter((c) => reasoningTextOf(c) !== undefined)
      .map((c) => reasoningTextOf(c))
      .join('')
    expect(reasoning).toBe('thinking')

    const content = chunks
      .filter((c) => contentTextOf(c) !== undefined)
      .map((c) => contentTextOf(c))
      .join('')
    expect(content).toBe('ok')
  })

  test('tool-only (no reasoning/text): index is 0', async () => {
    const events = [
      { toolUseEvent: { name: 't1', toolUseId: 'id1', input: '{"x":1}', stop: true } }
    ]

    const chunks = await collectSdkChunks(events)
    const starts = toolStartChunks(chunks)
    expect(starts.length).toBe(1)
    expect(starts[0].choices[0].delta.tool_calls[0].index).toBe(0)
  })
})

describe('tool-call index is 0-based ordinal (RAW path)', () => {
  test('text + 2 tools: indices are 0 and 1', async () => {
    const rawWire =
      '{"content":"ok"}' +
      '{"name":"t1","toolUseId":"id1","input":"{\\"a\\":1}","stop":true}' +
      '{"name":"t2","toolUseId":"id2","input":"{\\"b\\":2}","stop":true}'

    const chunks = await collectRawChunks(rawWire)

    const starts = toolStartChunks(chunks)
    expect(starts.length).toBe(2)

    const first = starts.find((c) => c.choices[0].delta.tool_calls[0].id === 'id1')
    const second = starts.find((c) => c.choices[0].delta.tool_calls[0].id === 'id2')
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first.choices[0].delta.tool_calls[0].index).toBe(0)
    expect(second.choices[0].delta.tool_calls[0].index).toBe(1)
  })
})
