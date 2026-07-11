import { describe, expect, test } from 'bun:test'
import { ResponseHandler } from '../core/request/response-handler.js'

// Covers ResponseHandler.handleSuccess — the raw-Kiro Response path (as opposed
// to handleSdkSuccess, covered in response-handler-sdk.test.ts). handleStreaming
// pipes a raw Kiro byte-stream Response through transformKiroStream into an SSE
// Response; handleNonStreaming reads the raw event-stream text and builds an
// OpenAI chat.completion via parseEventStream. We feed real ReadableStream /
// text Responses of Kiro's embedded-JSON event bytes — no network.
//
// NOTE: handleSuccess is currently public API but NOT wired into the live
// request loop (RequestHandler.handleKiroRequest only calls handleSdkSuccess);
// these tests pin the reachable raw-path behavior it still exposes.

function rawStreamResponse(str: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(str))
      controller.close()
    }
  })
  return new Response(stream)
}

async function readSseChunks(response: Response): Promise<any[]> {
  const text = await response.text()
  return text
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)))
}

describe('ResponseHandler.handleSuccess — streaming (raw Kiro path)', () => {
  test('streaming=true transforms raw content events into an SSE Response', async () => {
    const raw = '{"content":"Hello, "}{"content":"world"}'
    const response = await new ResponseHandler().handleSuccess(
      rawStreamResponse(raw),
      'claude-sonnet-4.5',
      'conv-stream-1',
      true
    )
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')

    const chunks = await readSseChunks(response)
    const content = chunks
      .map((c) => c?.choices?.[0]?.delta?.content)
      .filter((s) => s !== undefined)
      .join('')
    expect(content).toBe('Hello, world')
  })

  test('streaming surfaces a thinking block as reasoning_content deltas', async () => {
    const raw = '{"content":"<thinking>ponder</thinking>answer"}'
    const response = await new ResponseHandler().handleSuccess(
      rawStreamResponse(raw),
      'claude-sonnet-4.5',
      'conv-stream-2',
      true
    )
    const chunks = await readSseChunks(response)
    const reasoning = chunks
      .map((c) => c?.choices?.[0]?.delta?.reasoning_content)
      .filter((s) => s !== undefined)
      .join('')
    const content = chunks
      .map((c) => c?.choices?.[0]?.delta?.content)
      .filter((s) => s !== undefined)
      .join('')
    expect(reasoning).toBe('ponder')
    expect(content).toBe('answer')
  })

  test('a null body stream errors the SSE stream (transformKiroStream throws)', async () => {
    const response = await new ResponseHandler().handleSuccess(
      new Response(null),
      'auto',
      'conv-stream-3',
      true
    )
    // The ReadableStream.start propagates the "Response body is null" throw as a
    // stream error, so reading the body rejects.
    await expect(response.text()).rejects.toThrow()
  })
})

describe('ResponseHandler.handleSuccess — non-streaming (raw Kiro path)', () => {
  test('non-streaming builds a chat.completion from the raw event-stream text', async () => {
    const raw = '{"content":"Hello, "}{"content":"world"}'
    const response = await new ResponseHandler().handleSuccess(
      new Response(raw),
      'claude-sonnet-4.5',
      'conv-ns-1',
      false
    )
    const body = await response.json()
    expect(body.id).toBe('conv-ns-1')
    expect(body.object).toBe('chat.completion')
    expect(body.model).toBe('claude-sonnet-4.5')
    expect(body.choices[0].message.content).toBe('Hello, world')
    expect(body.choices[0].finish_reason).toBe('stop')
  })

  test('non-streaming tool-use text yields tool_calls and tool_calls finish_reason', async () => {
    const raw =
      '{"content":"before"}{"name":"read_file","toolUseId":"tid-1","input":"{\\"path\\":\\"/a.txt\\"}"}'
    const response = await new ResponseHandler().handleSuccess(
      new Response(raw),
      'auto',
      'conv-ns-2',
      false
    )
    const body = await response.json()
    expect(body.choices[0].finish_reason).toBe('tool_calls')
    const calls = body.choices[0].message.tool_calls
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('tid-1')
    expect(calls[0].function.name).toBe('read_file')
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: '/a.txt' })
  })

  test('non-streaming empty body yields empty content, zero usage, stop', async () => {
    const response = await new ResponseHandler().handleSuccess(
      new Response(''),
      'auto',
      'conv-ns-3',
      false
    )
    const body = await response.json()
    expect(body.choices[0].message.content).toBe('')
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(body.usage.total_tokens).toBe(0)
  })
})
