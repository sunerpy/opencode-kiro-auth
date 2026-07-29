import { describe, expect, test } from 'bun:test'
import {
  ReasoningAccumulator,
  type ReasoningContentEventLike
} from '../plugin/streaming/reasoning-accumulator.js'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'

const SIGNATURE = `sig-${'a'.repeat(320)}`
const OTHER_SIGNATURE = `sig-${'b'.repeat(320)}`

function makeSdkResponse(events: any[]): any {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const e of events) yield e
    })()
  }
}

async function runStream(
  events: any[],
  accumulator?: ReasoningAccumulator
): Promise<{ chunks: any[]; reasoning: string; content: string }> {
  const chunks: any[] = []
  for await (const chunk of transformSdkStream(
    makeSdkResponse(events),
    'auto',
    'chatcmpl-test',
    accumulator
  )) {
    chunks.push(chunk)
  }
  const reasoning = chunks
    .map((c) => c?.choices?.[0]?.delta?.reasoning_content)
    .filter((t): t is string => t !== undefined)
    .join('')
  const content = chunks
    .map((c) => c?.choices?.[0]?.delta?.content)
    .filter((t): t is string => t !== undefined)
    .join('')
  return { chunks, reasoning, content }
}

function feed(events: ReasoningContentEventLike[]): ReasoningAccumulator {
  const acc = new ReasoningAccumulator()
  for (const e of events) acc.observe(e)
  return acc
}

describe('ReasoningAccumulator envelope rules', () => {
  test('multiple text events with the signature in the final event', () => {
    const acc = feed([
      { text: 'Let me' },
      { text: ' think about' },
      { text: ' this', signature: SIGNATURE }
    ])

    expect(acc.finalize()).toEqual({
      kind: 'reasoningText',
      text: 'Let me think about this',
      signature: SIGNATURE
    })
  })

  test('text fragments are appended verbatim with no trimming or rewriting', () => {
    const acc = feed([
      { text: '  leading spaces' },
      { text: '\n\ttabbed\n' },
      { text: 'trailing  ', signature: SIGNATURE }
    ])

    const envelope = acc.finalize()
    expect(envelope?.kind).toBe('reasoningText')
    expect(envelope && 'text' in envelope ? envelope.text : '').toBe(
      '  leading spaces\n\ttabbed\ntrailing  '
    )
  })

  test('a trailing signature-only event completes the envelope', () => {
    const acc = feed([{ text: 'thinking hard' }, { signature: SIGNATURE }])

    expect(acc.finalize()).toEqual({
      kind: 'reasoningText',
      text: 'thinking hard',
      signature: SIGNATURE
    })
    expect(acc.snapshot()).toMatchObject({
      textEventCount: 1,
      signatureEventCount: 1,
      signaturePresent: true
    })
  })

  test('the last non-empty signature is retained when the same one repeats', () => {
    const acc = feed([
      { text: 'a', signature: SIGNATURE },
      { text: 'b', signature: SIGNATURE },
      { signature: SIGNATURE }
    ])

    const envelope = acc.finalize()
    expect(envelope).toEqual({ kind: 'reasoningText', text: 'ab', signature: SIGNATURE })
  })

  test('an empty signature field never clears a captured signature', () => {
    const acc = feed([
      { text: 'a', signature: SIGNATURE },
      { text: 'b', signature: '' }
    ])

    expect(acc.finalize()).toEqual({ kind: 'reasoningText', text: 'ab', signature: SIGNATURE })
    expect(acc.snapshot().signatureEventCount).toBe(1)
  })

  test('two differing non-empty signatures make the envelope unsupported', () => {
    const acc = feed([
      { text: 'a', signature: SIGNATURE },
      { text: 'b', signature: OTHER_SIGNATURE }
    ])

    expect(acc.finalize()).toBeUndefined()
    expect(acc.snapshot().rejection).toBe('conflicting-signature')
  })

  test('reasoning with no signature at all yields no envelope', () => {
    const acc = feed([{ text: 'unsigned reasoning' }])

    expect(acc.finalize()).toBeUndefined()
    expect(acc.snapshot()).toMatchObject({
      textLength: 'unsigned reasoning'.length,
      signaturePresent: false
    })
    expect(acc.snapshot().rejection).toBeUndefined()
  })

  test('redacted bytes are copied, not aliased or round-tripped through text', () => {
    const source = new Uint8Array([0, 1, 250, 255, 7])
    const acc = feed([{ redactedContent: source }])

    const envelope = acc.finalize()
    expect(envelope?.kind).toBe('redactedContent')
    const bytes = envelope && 'bytes' in envelope ? envelope.bytes : new Uint8Array()
    expect(Array.from(bytes)).toEqual([0, 1, 250, 255, 7])
    expect(bytes).not.toBe(source)

    source[0] = 99
    expect(Array.from(bytes)).toEqual([0, 1, 250, 255, 7])
  })

  test('multiple redacted events concatenate in arrival order', () => {
    const acc = feed([
      { redactedContent: new Uint8Array([1, 2]) },
      { redactedContent: new Uint8Array([3]) }
    ])

    const envelope = acc.finalize()
    const bytes = envelope && 'bytes' in envelope ? envelope.bytes : new Uint8Array()
    expect(Array.from(bytes)).toEqual([1, 2, 3])
  })

  test('mixed text and redacted content is unsupported rather than guessed', () => {
    const acc = feed([
      { text: 'visible thought', signature: SIGNATURE },
      { redactedContent: new Uint8Array([9, 9]) }
    ])

    expect(acc.finalize()).toBeUndefined()
    expect(acc.snapshot().rejection).toBe('mixed-text-and-redacted')
  })

  test('an empty event stream yields no envelope', () => {
    const acc = feed([{}, { text: '' }, { signature: '' }])

    expect(acc.finalize()).toBeUndefined()
    expect(acc.snapshot()).toMatchObject({
      textEventCount: 0,
      signatureEventCount: 0,
      redactedEventCount: 0
    })
  })

  test('a signature-only stream with no text yields no envelope', () => {
    const acc = feed([{ signature: SIGNATURE }])

    expect(acc.finalize()).toBeUndefined()
  })

  test('snapshot never exposes the signature or the redacted bytes', () => {
    const acc = feed([{ text: 'abc', signature: SIGNATURE }])

    const serialized = JSON.stringify(acc.snapshot())
    expect(serialized).not.toContain(SIGNATURE)
    expect(acc.snapshot().signatureLength).toBe(SIGNATURE.length)
  })

  test('reset discards a failed attempt so the next attempt starts clean', () => {
    const acc = feed([{ text: 'partial from failed attempt', signature: SIGNATURE }])
    acc.reset()
    expect(acc.finalize()).toBeUndefined()

    acc.observe({ text: 'retry reasoning', signature: OTHER_SIGNATURE })
    expect(acc.finalize()).toEqual({
      kind: 'reasoningText',
      text: 'retry reasoning',
      signature: OTHER_SIGNATURE
    })
  })

  test('observing null or undefined is a no-op', () => {
    const acc = new ReasoningAccumulator()
    acc.observe(undefined)
    acc.observe(null)
    expect(acc.snapshot().textEventCount).toBe(0)
  })
})

describe('transformSdkStream reasoning capture', () => {
  test('a signature-only event is captured and produces no visible output', async () => {
    const acc = new ReasoningAccumulator()
    const withSignature = await runStream(
      [
        { reasoningContentEvent: { text: 'Let me think' } },
        { reasoningContentEvent: { signature: SIGNATURE } },
        { assistantResponseEvent: { content: 'answer' } }
      ],
      acc
    )

    expect(acc.finalize()).toEqual({
      kind: 'reasoningText',
      text: 'Let me think',
      signature: SIGNATURE
    })
    expect(withSignature.reasoning).toBe('Let me think')
    expect(withSignature.content).toBe('answer')

    const withoutSignature = await runStream([
      { reasoningContentEvent: { text: 'Let me think' } },
      { assistantResponseEvent: { content: 'answer' } }
    ])

    expect(withSignature.chunks.length).toBe(withoutSignature.chunks.length)
  })

  test('a signature-only event does not corrupt thinking block indices', async () => {
    const withSignature = await runStream(
      [
        { reasoningContentEvent: { text: 'thought a' } },
        { reasoningContentEvent: { signature: SIGNATURE } },
        { reasoningContentEvent: { text: 'thought b' } },
        { assistantResponseEvent: { content: 'reply' } },
        { toolUseEvent: { toolUseId: 't1', name: 'search', input: '{"q":1}', stop: true } }
      ],
      new ReasoningAccumulator()
    )
    const withoutSignature = await runStream([
      { reasoningContentEvent: { text: 'thought a' } },
      { reasoningContentEvent: { text: 'thought b' } },
      { assistantResponseEvent: { content: 'reply' } },
      { toolUseEvent: { toolUseId: 't1', name: 'search', input: '{"q":1}', stop: true } }
    ])

    expect(withSignature.reasoning).toBe('thought athought b')
    expect(withSignature.content).toBe('reply')

    const strip = (chunks: any[]): string =>
      JSON.stringify(chunks.map((c) => ({ ...c, created: 0 })))
    expect(strip(withSignature.chunks)).toBe(strip(withoutSignature.chunks))
  })

  test('a redacted-content event is captured and never rendered', async () => {
    const acc = new ReasoningAccumulator()
    const { reasoning, content } = await runStream(
      [
        { reasoningContentEvent: { redactedContent: new Uint8Array([4, 5, 6]) } },
        { assistantResponseEvent: { content: 'reply' } }
      ],
      acc
    )

    expect(reasoning).toBe('')
    expect(content).toBe('reply')
    const envelope = acc.finalize()
    expect(envelope?.kind).toBe('redactedContent')
  })

  test('conflicting signatures across the stream leave no envelope', async () => {
    const acc = new ReasoningAccumulator()
    await runStream(
      [
        { reasoningContentEvent: { text: 'a', signature: SIGNATURE } },
        { reasoningContentEvent: { text: 'b', signature: OTHER_SIGNATURE } },
        { assistantResponseEvent: { content: 'reply' } }
      ],
      acc
    )

    expect(acc.finalize()).toBeUndefined()
    expect(acc.snapshot().rejection).toBe('conflicting-signature')
  })

  test('the stream works with no accumulator supplied', async () => {
    const { reasoning, content } = await runStream([
      { reasoningContentEvent: { text: 'thought' } },
      { reasoningContentEvent: { signature: SIGNATURE } },
      { assistantResponseEvent: { content: 'reply' } }
    ])

    expect(reasoning).toBe('thought')
    expect(content).toBe('reply')
  })

  test('two attempts with separate accumulators stay isolated', async () => {
    const first = new ReasoningAccumulator()
    const second = new ReasoningAccumulator()

    await runStream([{ reasoningContentEvent: { text: 'first', signature: SIGNATURE } }], first)
    await runStream(
      [{ reasoningContentEvent: { text: 'second', signature: OTHER_SIGNATURE } }],
      second
    )

    expect(first.finalize()).toEqual({
      kind: 'reasoningText',
      text: 'first',
      signature: SIGNATURE
    })
    expect(second.finalize()).toEqual({
      kind: 'reasoningText',
      text: 'second',
      signature: OTHER_SIGNATURE
    })
  })
})
