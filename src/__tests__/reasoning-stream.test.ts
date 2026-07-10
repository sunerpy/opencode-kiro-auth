import { describe, expect, test } from 'bun:test'
import { ResponseHandler } from '../core/request/response-handler.js'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'

// Build a fake SDK response from a plain array of events. transformSdkStream and
// handleSdkNonStreaming both read `sdkResponse.generateAssistantResponseResponse`
// as an async iterable of events.
function makeSdkResponse(events: any[]): any {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const e of events) yield e
    })()
  }
}

// Collect every chunk yielded by transformSdkStream into an array.
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

describe('transformSdkStream reasoningContentEvent handling', () => {
  test('reasoning-then-text: separates reasoning_content from content and preserves order', async () => {
    const events = [
      { reasoningContentEvent: { text: 'Let me' } },
      { reasoningContentEvent: { text: ' think' } },
      { assistantResponseEvent: { content: 'The answer' } },
      { assistantResponseEvent: { content: ' is 42' } },
      { metadataEvent: { tokenUsage: { inputTokens: 10, outputTokens: 5 } } }
    ]

    const chunks = await collectChunks(events)

    const reasoningChunks = chunks.filter((c) => reasoningTextOf(c) !== undefined)
    const contentChunks = chunks.filter((c) => contentTextOf(c) !== undefined)

    // Reasoning deltas concatenate to the full reasoning text.
    const reasoning = reasoningChunks.map((c) => reasoningTextOf(c)).join('')
    expect(reasoning).toBe('Let me think')

    // Text deltas concatenate to the full reply text.
    const content = contentChunks.map((c) => contentTextOf(c)).join('')
    expect(content).toBe('The answer is 42')

    // ORDER: every reasoning_content chunk must appear before the first content chunk.
    const firstContentIndex = chunks.findIndex((c) => contentTextOf(c) !== undefined)
    const lastReasoningIndex = chunks.reduce(
      (acc, c, i) => (reasoningTextOf(c) !== undefined ? i : acc),
      -1
    )
    expect(firstContentIndex).toBeGreaterThan(-1)
    expect(lastReasoningIndex).toBeGreaterThan(-1)
    expect(lastReasoningIndex).toBeLessThan(firstContentIndex)
  })

  test('text-only: no reasoning_content, content concatenates cleanly', async () => {
    const events = [
      { assistantResponseEvent: { content: 'Hello' } },
      { assistantResponseEvent: { content: ' world' } }
    ]

    const chunks = await collectChunks(events)

    const content = chunks
      .filter((c) => contentTextOf(c) !== undefined)
      .map((c) => contentTextOf(c))
      .join('')
    expect(content).toBe('Hello world')

    // No reasoning_content chunk should be emitted at all.
    const anyReasoning = chunks.some((c) => reasoningTextOf(c) !== undefined)
    expect(anyReasoning).toBe(false)
  })

  test('reasoning-only: emits reasoning_content, no content, finalizes cleanly', async () => {
    const events = [{ reasoningContentEvent: { text: 'thinking...' } }]

    const chunks = await collectChunks(events)

    const reasoning = chunks
      .filter((c) => reasoningTextOf(c) !== undefined)
      .map((c) => reasoningTextOf(c))
      .join('')
    expect(reasoning).toBe('thinking...')

    // No reply text emitted.
    const anyContent = chunks.some((c) => contentTextOf(c) !== undefined)
    expect(anyContent).toBe(false)
  })
})

describe('ResponseHandler non-streaming reasoningContentEvent collection', () => {
  test('accumulates reasoning_content and content onto the chat.completion message', async () => {
    const events = [
      { reasoningContentEvent: { text: 'reason' } },
      { assistantResponseEvent: { content: 'reply' } }
    ]

    const handler = new ResponseHandler()
    const response = await handler.handleSdkSuccess(
      makeSdkResponse(events),
      'auto',
      'chatcmpl-test',
      false
    )

    const body = await response.json()
    expect(body.object).toBe('chat.completion')
    expect(body.choices[0].message.reasoning_content).toBe('reason')
    expect(body.choices[0].message.content).toBe('reply')
  })
})
