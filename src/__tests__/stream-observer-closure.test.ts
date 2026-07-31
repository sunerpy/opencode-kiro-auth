import { describe, expect, test } from 'bun:test'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'
import { StreamObserver } from '../plugin/streaming/stream-observer.js'

function makeSdkResponse(events: readonly unknown[]): object {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
    })()
  }
}

async function drain(events: readonly unknown[], observer: StreamObserver): Promise<void> {
  for await (const _chunk of transformSdkStream(
    makeSdkResponse(events),
    'auto',
    'chatcmpl-observer-closure',
    undefined,
    observer
  )) {
    void _chunk
  }
}

describe('StreamObserver — tool intent closure', () => {
  test('a raw tool sequence closes only when its final event carries stop true', async () => {
    const observer = new StreamObserver()

    await drain(
      [
        { toolUseEvent: { toolUseId: 'tu-1', name: 'read', input: '{"path":' } },
        {
          toolUseEvent: { toolUseId: 'tu-1', name: 'read', input: '"/tmp/x"}', stop: true }
        }
      ],
      observer
    )

    expect(observer.sawToolIntent).toBe(true)
    expect(observer.hasOpenToolIntent).toBe(false)
  })

  test('a dialect marker stays open when finalization parses no complete tool call', async () => {
    const observer = new StreamObserver()

    await drain(
      [{ assistantResponseEvent: { content: '<invoke name="read"><parameter name="path">/tmp' } }],
      observer
    )

    expect(observer.hasOpenToolIntent).toBe(true)
  })

  test('a dialect marker closes when finalization parses a complete tool call', async () => {
    const observer = new StreamObserver()

    await drain(
      [
        {
          assistantResponseEvent: {
            content: '<invoke name="read"><parameter name="path">/tmp/x</parameter></invoke>'
          }
        }
      ],
      observer
    )

    expect(observer.hasOpenToolIntent).toBe(false)
  })

  test('a complete invoke followed by a truncated invoke keeps the dialect intent open', async () => {
    const observer = new StreamObserver()

    await drain(
      [
        {
          assistantResponseEvent: {
            content:
              '<invoke name="read"><parameter name="path">/tmp/x</parameter></invoke>' +
              '<invoke name="write"><parameter name="path">/truncated'
          }
        }
      ],
      observer
    )

    expect(observer.sawToolIntent).toBe(true)
    expect(observer.hasOpenToolIntent).toBe(true)
  })

  for (const [region, content] of [
    [
      'fenced code',
      'Example:\n```xml\n<invoke name="read"><parameter name="path">/tmp/x</parameter></invoke>\n```'
    ],
    ['inline code', 'Use `<invoke name="read"><parameter name="path">/tmp/x</parameter></invoke>`.']
  ] as const) {
    test(`a marker inside ${region} never opens dialect intent`, async () => {
      const observer = new StreamObserver()

      await drain([{ assistantResponseEvent: { content } }], observer)

      expect(observer.sawToolIntent).toBe(false)
      expect(observer.hasOpenToolIntent).toBe(false)
      expect(observer.dialectActive).toBe(true)
    })
  }
})
