import { describe, expect, test } from 'bun:test'
import { ResponseHandler } from '../core/request/response-handler.js'

function makeSdkResponse(events: any[]): any {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const e of events) yield e
    })()
  }
}

function makeFailingSdkResponse(events: any[], error: Error): any {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
      throw error
    })()
  }
}

async function readSseChunks(response: Response): Promise<any[]> {
  const text = await response.text()
  return text
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)))
}

describe('handleSdkSuccess — non-streaming', () => {
  test('plain text response builds a chat.completion with stop finish_reason', async () => {
    const events = [
      { assistantResponseEvent: { content: 'Hello ' } },
      { assistantResponseEvent: { content: 'world' } },
      { metadataEvent: { tokenUsage: { inputTokens: 12, outputTokens: 3 } } }
    ]
    const response = await new ResponseHandler().handleSdkSuccess(
      makeSdkResponse(events),
      'claude-sonnet-4.5',
      'conv-1',
      false
    )
    const body = await response.json()
    expect(body.id).toBe('conv-1')
    expect(body.object).toBe('chat.completion')
    expect(body.model).toBe('claude-sonnet-4.5')
    expect(body.choices[0].message.content).toBe('Hello world')
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(body.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
  })

  test('tool use events produce tool_calls and tool_calls finish_reason', async () => {
    const events = [
      { assistantResponseEvent: { content: 'calling tool' } },
      { toolUseEvent: { toolUseId: 'tu1', name: 'get_weather', input: { city: 'SF' } } }
    ]
    const response = await new ResponseHandler().handleSdkSuccess(
      makeSdkResponse(events),
      'auto',
      'conv-2',
      false
    )
    const body = await response.json()
    expect(body.choices[0].finish_reason).toBe('tool_calls')
    expect(body.choices[0].message.tool_calls).toEqual([
      {
        id: 'tu1',
        type: 'function',
        function: { name: 'get_weather', arguments: JSON.stringify({ city: 'SF' }) }
      }
    ])
  })

  test('string tool input is passed through verbatim as arguments', async () => {
    const events = [{ toolUseEvent: { toolUseId: 't', name: 'f', input: '{"raw":true}' } }]
    const response = await new ResponseHandler().handleSdkSuccess(
      makeSdkResponse(events),
      'auto',
      'conv-3',
      false
    )
    const body = await response.json()
    expect(body.choices[0].message.tool_calls[0].function.arguments).toBe('{"raw":true}')
  })

  test('reasoning content is attached to the message as reasoning_content', async () => {
    const events = [
      { reasoningContentEvent: { text: 'thinking...' } },
      { assistantResponseEvent: { content: 'answer' } }
    ]
    const response = await new ResponseHandler().handleSdkSuccess(
      makeSdkResponse(events),
      'auto',
      'conv-4',
      false
    )
    const body = await response.json()
    expect(body.choices[0].message.reasoning_content).toBe('thinking...')
    expect(body.choices[0].message.content).toBe('answer')
  })

  test('empty event stream yields empty content, zero usage', async () => {
    const response = await new ResponseHandler().handleSdkSuccess(
      makeSdkResponse([]),
      'auto',
      'conv-5',
      false
    )
    const body = await response.json()
    expect(body.choices[0].message.content).toBe('')
    expect(body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
  })

  test('missing generateAssistantResponseResponse yields empty completion', async () => {
    const response = await new ResponseHandler().handleSdkSuccess({}, 'auto', 'conv-6', false)
    const body = await response.json()
    expect(body.choices[0].message.content).toBe('')
    expect(body.choices[0].finish_reason).toBe('stop')
  })

  test('raw iterator failure rejects with the typed stream-iteration boundary', async () => {
    const upstream = new Error('event stream deserialization failed')

    await expect(
      new ResponseHandler().handleSdkSuccess(
        makeFailingSdkResponse([], upstream),
        'auto',
        'c',
        false
      )
    ).rejects.toMatchObject({
      name: 'SdkEventStreamIterationError',
      cause: upstream
    })
  })
})

describe('handleSdkSuccess — streaming', () => {
  test('streaming=true returns an SSE Response with text deltas', async () => {
    const events = [
      { assistantResponseEvent: { content: 'A' } },
      { assistantResponseEvent: { content: 'B' } }
    ]
    const response = await new ResponseHandler().handleSdkSuccess(
      makeSdkResponse(events),
      'auto',
      'conv-7',
      true
    )
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')

    const chunks = await readSseChunks(response)
    const content = chunks
      .map((c) => c.choices?.[0]?.delta?.content)
      .filter((c) => c !== undefined)
      .join('')
    expect(content).toBe('AB')
  })

  test('pre-output raw iterator failure rejects before returning a Response', async () => {
    const upstream = new Error('HTTP 200 stream decode failure')

    await expect(
      new ResponseHandler().handleSdkSuccess(
        makeFailingSdkResponse([], upstream),
        'auto',
        'c',
        true
      )
    ).rejects.toMatchObject({
      name: 'SdkEventStreamIterationError',
      cause: upstream
    })
  })

  test('post-output failure preserves the first semantic chunk before rejecting', async () => {
    const upstream = new Error('stream failed after output')
    const mapped = new Error('mapped post-output failure')
    const emitted: boolean[] = []
    const response = await new ResponseHandler().handleSdkSuccess(
      makeFailingSdkResponse([{ reasoningContentEvent: { text: 'visible thought' } }], upstream),
      'auto',
      'c',
      true,
      {
        mapError(error, emittedOutput) {
          expect(error).toMatchObject({ name: 'SdkEventStreamIterationError', cause: upstream })
          emitted.push(emittedOutput)
          return mapped
        }
      }
    )

    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('visible thought')
    await expect(reader.read()).rejects.toBe(mapped)
    expect(emitted).toEqual([true])
  })

  test('normal completion invokes the lifecycle callback exactly once', async () => {
    let completions = 0
    const response = await new ResponseHandler().handleSdkSuccess(
      makeSdkResponse([{ assistantResponseEvent: { content: 'completed response' } }]),
      'auto',
      'c',
      true,
      {
        onComplete: () => {
          completions++
        }
      }
    )

    expect(completions).toBe(0)
    await response.text()
    expect(completions).toBe(1)
  })

  test('empty upstream completion returns an empty SSE body and completes exactly once', async () => {
    let completions = 0
    const response = await new ResponseHandler().handleSdkSuccess(
      makeSdkResponse([]),
      'auto',
      'empty',
      true,
      {
        onComplete: () => {
          completions++
        }
      }
    )

    expect(completions).toBe(1)
    expect(await response.text()).toContain('"finish_reason":"stop"')
    expect(completions).toBe(1)
  })

  test('consumer cancellation closes the raw iterator without completing successfully', async () => {
    let returnCalls = 0
    let completions = 0
    let yielded = false
    const sdkResponse = {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (!yielded) {
                yielded = true
                return {
                  done: false,
                  value: { reasoningContentEvent: { text: 'first output' } }
                }
              }
              return new Promise<IteratorResult<unknown>>(() => {})
            },
            async return() {
              returnCalls++
              return { done: true, value: undefined }
            }
          }
        }
      }
    }
    const response = await new ResponseHandler().handleSdkSuccess(
      sdkResponse,
      'auto',
      'cancel-conv',
      true,
      {
        onComplete: () => {
          completions++
        }
      }
    )
    const reader = response.body!.getReader()

    expect(new TextDecoder().decode((await reader.read()).value)).toContain('first output')
    await reader.cancel('consumer stopped')

    expect(returnCalls).toBeGreaterThanOrEqual(1)
    expect(completions).toBe(0)
  })

  test('an idle post-output stream observes abort and closes its raw iterator', async () => {
    const controller = new AbortController()
    let returnCalls = 0
    let yielded = false
    const sdkResponse = {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (!yielded) {
                yielded = true
                return {
                  done: false,
                  value: { reasoningContentEvent: { text: 'first output' } }
                }
              }
              return new Promise<IteratorResult<unknown>>(() => {})
            },
            async return() {
              returnCalls++
              return { done: true, value: undefined }
            }
          }
        }
      }
    }
    const response = await new ResponseHandler().handleSdkSuccess(
      sdkResponse,
      'auto',
      'abort-conv',
      true,
      { signal: controller.signal }
    )
    const reader = response.body!.getReader()
    await reader.read()

    controller.abort(new DOMException('request cancelled', 'AbortError'))

    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    expect(returnCalls).toBeGreaterThanOrEqual(1)
  })
})
