import { parseEventStream } from '../../plugin/response'
import { transformKiroStream } from '../../plugin/streaming/index.js'
import { transformSdkStream } from '../../plugin/streaming/sdk-stream-transformer.js'
import { SdkEventStreamIterationError } from './stream-error.js'

export interface SdkResponseLifecycle {
  signal?: AbortSignal
  onComplete?: () => void | Promise<void>
  onTerminal?: () => void
  onCancel?: (reason: unknown) => void
  mapError?: (error: SdkEventStreamIterationError, emittedOutput: true) => unknown
}

interface WrappedSdkStream {
  response: any
  closeRaw: () => Promise<void>
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The request was aborted', 'AbortError')
}

async function closeIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  try {
    await iterator.return?.()
  } catch {}
}

function wrapSdkEventStream(sdkResponse: any, signal?: AbortSignal): WrappedSdkStream {
  const eventStream = sdkResponse.generateAssistantResponseResponse
  if (!eventStream || typeof eventStream[Symbol.asyncIterator] !== 'function') {
    return { response: sdkResponse, closeRaw: async () => {} }
  }

  const rawIterator = eventStream[Symbol.asyncIterator]() as AsyncIterator<unknown>
  let closed = false
  const closeRaw = async (): Promise<void> => {
    if (closed) return
    closed = true
    await closeIterator(rawIterator)
  }

  const nextRaw = async (): Promise<IteratorResult<unknown>> => {
    if (!signal) return rawIterator.next()
    if (signal.aborted) {
      await closeRaw()
      throw abortReason(signal)
    }

    return new Promise<IteratorResult<unknown>>((resolve, reject) => {
      let settled = false
      const settle = (callback: () => void): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        callback()
      }
      const onAbort = (): void => {
        void closeRaw()
        settle(() => reject(abortReason(signal)))
      }

      signal.addEventListener('abort', onAbort, { once: true })
      Promise.resolve(rawIterator.next()).then(
        (result) => settle(() => resolve(result)),
        (error) => settle(() => reject(error))
      )
    })
  }

  const wrappedIterator: AsyncIterator<unknown> = {
    async next() {
      try {
        return await nextRaw()
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal)
        throw new SdkEventStreamIterationError(error)
      }
    },
    async return() {
      await closeRaw()
      return { done: true, value: undefined }
    }
  }

  const wrappedStream = {
    [Symbol.asyncIterator]() {
      return wrappedIterator
    }
  }

  return {
    response: { ...sdkResponse, generateAssistantResponseResponse: wrappedStream },
    closeRaw
  }
}

function isSemanticChunk(chunk: any): boolean {
  const delta = chunk?.choices?.[0]?.delta
  return (
    delta?.content !== undefined ||
    delta?.reasoning_content !== undefined ||
    delta?.tool_calls !== undefined
  )
}

function encodeSseChunk(chunk: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
}

export class ResponseHandler {
  async handleSuccess(
    response: Response,
    model: string,
    conversationId: string,
    streaming: boolean
  ): Promise<Response> {
    if (streaming) {
      return this.handleStreaming(response, model, conversationId)
    }
    return this.handleNonStreaming(response, model, conversationId)
  }

  async handleSdkSuccess(
    sdkResponse: any,
    model: string,
    conversationId: string,
    streaming: boolean,
    lifecycle: SdkResponseLifecycle = {}
  ): Promise<Response> {
    if (streaming) {
      return this.handleSdkStreaming(sdkResponse, model, conversationId, lifecycle)
    }
    return this.handleSdkNonStreaming(sdkResponse, model, conversationId, lifecycle.signal)
  }

  private async handleStreaming(
    response: Response,
    model: string,
    conversationId: string
  ): Promise<Response> {
    const s = transformKiroStream(response, model, conversationId)
    return new Response(
      new ReadableStream({
        async start(c) {
          try {
            for await (const e of s) {
              c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`))
            }
            c.close()
          } catch (err) {
            c.error(err)
          }
        }
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }

  private async handleSdkStreaming(
    sdkResponse: any,
    model: string,
    conversationId: string,
    lifecycle: SdkResponseLifecycle
  ): Promise<Response> {
    const wrapped = wrapSdkEventStream(sdkResponse, lifecycle.signal)
    const transformed = transformSdkStream(wrapped.response, model, conversationId)
    const buffered: Uint8Array[] = []
    let firstSemantic: Uint8Array | undefined

    while (true) {
      const item = await transformed.next()
      if (item.done) {
        await lifecycle.onComplete?.()
        lifecycle.onTerminal?.()
        let index = 0
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                const chunk = buffered[index++]
                if (chunk) controller.enqueue(chunk)
                if (index >= buffered.length) controller.close()
              }
            },
            { highWaterMark: 0 }
          ),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
      }

      const encoded = encodeSseChunk(item.value)
      if (isSemanticChunk(item.value)) {
        firstSemantic = encoded
        break
      }
      buffered.push(encoded)
    }

    let terminal = false
    let firstPull = true
    let abortListener: (() => void) | undefined
    const finish = (): void => {
      if (terminal) return
      terminal = true
      if (abortListener && lifecycle.signal) {
        lifecycle.signal.removeEventListener('abort', abortListener)
      }
      lifecycle.onTerminal?.()
    }
    const cleanupIterators = async (): Promise<void> => {
      try {
        await transformed.return(undefined)
      } catch {}
      await wrapped.closeRaw()
    }

    return new Response(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            if (!lifecycle.signal) return
            abortListener = () => {
              if (terminal) return
              const reason = abortReason(lifecycle.signal!)
              void cleanupIterators()
              finish()
              controller.error(reason)
            }
            if (lifecycle.signal.aborted) abortListener()
            else lifecycle.signal.addEventListener('abort', abortListener, { once: true })
          },
          async pull(controller) {
            if (terminal) return
            if (firstPull) {
              firstPull = false
              for (const chunk of buffered) controller.enqueue(chunk)
              controller.enqueue(firstSemantic!)
              return
            }

            try {
              const item = await transformed.next()
              if (item.done) {
                await lifecycle.onComplete?.()
                finish()
                controller.close()
                return
              }
              controller.enqueue(encodeSseChunk(item.value))
            } catch (error) {
              if (terminal) return
              const mapped =
                error instanceof SdkEventStreamIterationError
                  ? (lifecycle.mapError?.(error, true) ?? error)
                  : error
              finish()
              controller.error(mapped)
            }
          },
          async cancel(reason) {
            if (terminal) return
            finish()
            lifecycle.onCancel?.(reason)
            await cleanupIterators()
          }
        },
        { highWaterMark: 0 }
      ),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }

  private async handleSdkNonStreaming(
    sdkResponse: any,
    model: string,
    conversationId: string,
    signal?: AbortSignal
  ): Promise<Response> {
    // For non-streaming SDK responses, collect all events
    let content = ''
    let reasoningContent = ''
    const toolCalls: any[] = []
    let inputTokens = 0
    let outputTokens = 0

    const wrapped = wrapSdkEventStream(sdkResponse, signal)
    const eventStream = wrapped.response.generateAssistantResponseResponse
    if (eventStream) {
      try {
        for await (const event of eventStream) {
          if (event.reasoningContentEvent?.text) {
            reasoningContent += event.reasoningContentEvent.text
          }
          if (event.assistantResponseEvent?.content) {
            content += event.assistantResponseEvent.content
          }
          if (event.toolUseEvent) {
            toolCalls.push(event.toolUseEvent)
          }
          if (event.metadataEvent?.tokenUsage) {
            inputTokens = event.metadataEvent.tokenUsage.inputTokens || 0
            outputTokens = event.metadataEvent.tokenUsage.outputTokens || 0
          }
        }
      } finally {
        if (signal?.aborted) await wrapped.closeRaw()
      }
    }

    const message: any = { role: 'assistant', content }
    if (reasoningContent) {
      message.reasoning_content = reasoningContent
    }

    const oai: any = {
      id: conversationId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
        }
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
      }
    }

    if (toolCalls.length > 0) {
      oai.choices[0].message.tool_calls = toolCalls.map((tc) => ({
        id: tc.toolUseId,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
        }
      }))
    }

    return new Response(JSON.stringify(oai), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  private async handleNonStreaming(
    response: Response,
    model: string,
    conversationId: string
  ): Promise<Response> {
    const text = await response.text()
    const p = parseEventStream(text, model)
    const oai: any = {
      id: conversationId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: p.content },
          finish_reason: p.stopReason === 'tool_use' ? 'tool_calls' : 'stop'
        }
      ],
      usage: {
        prompt_tokens: p.inputTokens || 0,
        completion_tokens: p.outputTokens || 0,
        total_tokens: (p.inputTokens || 0) + (p.outputTokens || 0)
      }
    }

    if (p.toolCalls.length > 0) {
      oai.choices[0].message.tool_calls = p.toolCalls.map((tc) => ({
        id: tc.toolUseId,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
        }
      }))
    }

    return new Response(JSON.stringify(oai), {
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
