import { describe, expect, test } from 'bun:test'
import { DSML_MARKER } from '../infrastructure/transformers/tool-call-parser.js'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'
import { StreamObserver } from '../plugin/streaming/stream-observer.js'

// Same fake-SDK shape the other transformer suites use: transformSdkStream reads
// `sdkResponse.generateAssistantResponseResponse` as an async iterable of events.
function makeSdkResponse(events: any[]): any {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const e of events) yield e
    })()
  }
}

// An event stream that dies mid-flight, standing in for a post-200 iterator failure.
function makeBreakingSdkResponse(events: any[]): any {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const e of events) yield e
      throw new Error('upstream event stream broke')
    })()
  }
}

async function collectUntilBreak(
  events: any[],
  observer: StreamObserver
): Promise<{ chunks: any[]; broke: boolean }> {
  const chunks: any[] = []
  let broke = false
  try {
    for await (const chunk of transformSdkStream(
      makeBreakingSdkResponse(events),
      'auto',
      'chatcmpl-obs',
      undefined,
      observer
    )) {
      chunks.push(chunk)
    }
  } catch {
    broke = true
  }
  return { chunks, broke }
}

async function collectAll(events: any[], observer?: StreamObserver): Promise<any[]> {
  const chunks: any[] = []
  for await (const chunk of transformSdkStream(
    makeSdkResponse(events),
    'auto',
    'chatcmpl-obs',
    undefined,
    observer
  )) {
    chunks.push(chunk)
  }
  return chunks
}

function toolCallChunks(chunks: any[]): any[] {
  return chunks.filter((c) => c?.choices?.[0]?.delta?.tool_calls !== undefined)
}

function contentOf(chunk: any): string | undefined {
  return chunk?.choices?.[0]?.delta?.content
}

// Two run-scoped values are legitimately unstable across two runs of the same
// sequence and are NOT part of the emit contract: the per-chunk wall-clock
// `created` second, and the synthetic `tool_<ts>_<rand>` id the text-dialect
// parser mints for a call the upstream never gave an id. Everything else — key
// order included — must match byte for byte.
const SYNTHETIC_TOOL_ID = /^tool_\d+_[a-z0-9]+$/

function normalize(chunks: any[]): string {
  const stable = JSON.stringify(chunks, (key, value) => {
    if (key === 'created') return 0
    if (key === 'id' && typeof value === 'string' && SYNTHETIC_TOOL_ID.test(value)) {
      return 'tool_synthetic'
    }
    return value
  })
  return stable
}

describe('StreamObserver — ingestion-time tool intent', () => {
  test('toolUseEvent then stream break: sawToolIntent true with zero tool chunks emitted', async () => {
    // Given: reasoning + text land, a raw toolUseEvent arrives, then the stream dies
    // before the transformer's end-of-stream tool flush.
    const observer = new StreamObserver()
    const { chunks, broke } = await collectUntilBreak(
      [
        { assistantResponseEvent: { content: 'working on it' } },
        { toolUseEvent: { toolUseId: 'tu-1', name: 'read', input: '{"path":"/tmp/x"}' } }
      ],
      observer
    )

    // Then: the iterator failed, no tool_calls chunk ever reached the consumer,
    // yet the intent is already observable.
    expect(broke).toBe(true)
    expect(toolCallChunks(chunks).length).toBe(0)
    expect(observer.sawToolIntent).toBe(true)
    expect(observer.snapshot().sawToolIntent).toBe(true)
  })

  test('incomplete toolUseEvent (no name/id) still counts as tool intent', async () => {
    // Given: a toolUseEvent-family event that the transformer itself discards.
    const observer = new StreamObserver()
    const { chunks } = await collectUntilBreak(
      [{ toolUseEvent: { input: '{"partial":' } }],
      observer
    )

    expect(toolCallChunks(chunks).length).toBe(0)
    expect(observer.sawToolIntent).toBe(true)
  })

  test('text-dialect tool marker then stream break: sawToolIntent and dialectActive true', async () => {
    const observer = new StreamObserver()
    const { chunks, broke } = await collectUntilBreak(
      [
        { assistantResponseEvent: { content: 'let me look' } },
        { assistantResponseEvent: { content: '<invoke name="read"><parameter name="path">/tmp' } }
      ],
      observer
    )

    expect(broke).toBe(true)
    expect(toolCallChunks(chunks).length).toBe(0)
    expect(observer.dialectActive).toBe(true)
    expect(observer.sawToolIntent).toBe(true)
    // The dialect span itself must never have been streamed as visible text.
    const visible = chunks.map((c) => contentOf(c) ?? '').join('')
    expect(visible).not.toContain('<invoke')
  })

  test('DSML dialect marker also flips dialectActive', async () => {
    const observer = new StreamObserver()
    await collectUntilBreak(
      [{ assistantResponseEvent: { content: `answer\n${DSML_MARKER} name="grep"` } }],
      observer
    )

    expect(observer.dialectActive).toBe(true)
    expect(observer.sawToolIntent).toBe(true)
  })
})

describe('StreamObserver — reasoning phase', () => {
  test('pure reasoning then break: phase active, no tool intent', async () => {
    const observer = new StreamObserver()
    const { chunks, broke } = await collectUntilBreak(
      [
        { reasoningContentEvent: { text: 'Let me' } },
        { reasoningContentEvent: { text: ' think' } }
      ],
      observer
    )

    expect(broke).toBe(true)
    expect(observer.reasoningPhase).toBe('active')
    expect(observer.sawToolIntent).toBe(false)
    expect(observer.dialectActive).toBe(false)
    // Reasoning WAS delivered before the break — that is what makes this Tier A.
    const reasoning = chunks.map((c) => c?.choices?.[0]?.delta?.reasoning_content ?? '').join('')
    expect(reasoning).toBe('Let me think')
  })

  test('reasoning then text then break: phase ended', async () => {
    const observer = new StreamObserver()
    await collectUntilBreak(
      [
        { reasoningContentEvent: { text: 'thinking' } },
        { assistantResponseEvent: { content: 'answer' } }
      ],
      observer
    )

    expect(observer.reasoningPhase).toBe('ended')
    expect(observer.sawToolIntent).toBe(false)
  })

  test('text-only stream: phase stays none', async () => {
    const observer = new StreamObserver()
    await collectAll([{ assistantResponseEvent: { content: 'plain answer' } }], observer)

    expect(observer.reasoningPhase).toBe('none')
    expect(observer.snapshot()).toEqual({
      sawToolIntent: false,
      reasoningPhase: 'none',
      dialectActive: false
    })
  })

  test('inline <thinking> tag stream: phase reaches ended after the closing tag', async () => {
    const observer = new StreamObserver()
    await collectAll(
      [{ assistantResponseEvent: { content: '<thinking>weighing</thinking>\n\nthe reply' } }],
      observer
    )

    expect(observer.reasoningPhase).toBe('ended')
  })

  test('unterminated inline <thinking>: phase ends when the buffer is flushed', async () => {
    const observer = new StreamObserver()
    await collectAll([{ assistantResponseEvent: { content: '<thinking>never closed' } }], observer)

    expect(observer.reasoningPhase).toBe('ended')
  })
})

describe('StreamObserver — emitted chunks are byte-identical with and without it', () => {
  const sequences: Array<{ name: string; events: any[] }> = [
    {
      name: 'reasoning + text',
      events: [
        { reasoningContentEvent: { text: 'Let me think' } },
        { reasoningContentEvent: { signature: 'sig-abc' } },
        { assistantResponseEvent: { content: 'The answer' } },
        { assistantResponseEvent: { content: ' is 42' } },
        { metadataEvent: { contextUsagePercentage: 12 } }
      ]
    },
    {
      name: 'text + structured toolUse',
      events: [
        { assistantResponseEvent: { content: 'reading the file' } },
        {
          toolUseEvent: { toolUseId: 'tu-1', name: 'read', input: '{"path":"/tmp/x"}', stop: true }
        },
        { metadataEvent: { tokenUsage: { inputTokens: 10, outputTokens: 5 } } }
      ]
    },
    {
      name: 'text-dialect tool call',
      events: [
        { assistantResponseEvent: { content: 'before ' } },
        {
          assistantResponseEvent: {
            content: '<invoke name="read"><parameter name="path">/tmp/x</parameter></invoke>'
          }
        },
        { assistantResponseEvent: { content: ' after' } }
      ]
    }
  ]

  for (const { name, events } of sequences) {
    test(`${name}: identical chunk sequence`, async () => {
      const withoutObserver = await collectAll(events)
      const observer = new StreamObserver()
      const withObserver = await collectAll(events, observer)

      expect(withObserver.length).toBe(withoutObserver.length)
      expect(normalize(withObserver)).toBe(normalize(withoutObserver))
    })
  }
})
