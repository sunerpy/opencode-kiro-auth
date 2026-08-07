import {
  EmittedOutputAccumulator,
  type EmittedToolUse
} from '../../plugin/reasoning/emitted-output.js'
import { resolveLoop } from '../../plugin/reasoning/turn-identity.js'
import { parseEventStream } from '../../plugin/response'
import { transformKiroStream } from '../../plugin/streaming/index.js'
import { ReasoningAccumulator } from '../../plugin/streaming/reasoning-accumulator.js'
import { transformSdkStream } from '../../plugin/streaming/sdk-stream-transformer.js'
import type { StreamObserver } from '../../plugin/streaming/stream-observer.js'
import type { KiroReasoningContent } from '../../plugin/types.js'
import { detectForwardActionCommitment } from './action-commitment.js'
import { SdkEventStreamIterationError } from './stream-error.js'
import type {
  AttemptHandle,
  StreamRecoveryCompletion,
  StreamRecoveryMode
} from './stream-recovery.js'

/**
 * What a completed SDK stream hands back to the request layer.
 *
 * `loopId` is optional and that is load-bearing: `onComplete` also commits
 * success state and usage for a plain no-tool answer, which has no loop at all.
 * Typing it required would force a fabricated value on exactly the responses
 * that must leave the correlation cache untouched.
 */
export interface SdkCompletionPayload {
  envelope?: KiroReasoningContent
  reasoningText: string
  visibleText: string
  toolUses: EmittedToolUse[]
  attemptId: string
  loopId?: string
  effectiveModel: string
  recovered?: boolean
}

export type SdkStreamingAttempt = AttemptHandle & {
  readonly complete: (completion: StreamRecoveryCompletion) => Promise<void>
}

export type SdkStreamingAttemptInput = {
  readonly sdkResponse: unknown
  readonly model: string
  readonly conversationId: string
  readonly lifecycle: SdkResponseLifecycle
  readonly recoveryMode: StreamRecoveryMode
}

export interface SdkResponseLifecycle {
  signal?: AbortSignal
  onUpstreamWaitStart?: (context: { eventIndex: number }) => void
  onUpstreamWaitEnd?: () => void
  onIterationError?: (error: unknown, afterCompletionMetadata: boolean) => void
  onComplete?: (completed: SdkCompletionPayload) => void | Promise<void>
  onTerminal?: () => void
  onCancel?: (reason: unknown) => void
  mapError?: (error: SdkEventStreamIterationError, emittedOutput: true) => unknown
  bufferUntilComplete?: boolean
  /** Request-scoped, unique per SDK send attempt. Unrelated to account epochs. */
  attemptId?: string
  /** Loop root recovered from inbound history, if any. */
  inheritedLoopId?: string
  effectiveModel?: string
  /**
   * Owned by the caller so the ingestion-time signals stay readable after this
   * attempt fails — the streaming branch only feeds it.
   */
  streamObserver?: StreamObserver
  /**
   * Owned by the caller for the same reason as `streamObserver`: the emitted
   * per-channel volume has to stay readable after the attempt fails. Defaults to
   * an internal instance when absent, so callers that do not observe are unchanged.
   */
  emittedOutput?: EmittedOutputAccumulator
  /**
   * The SDK iterator reached a clean `done` without ever delivering completion
   * metadata. Observation only — success handling proceeds exactly as before.
   */
  onCleanEofWithoutCompletionMetadata?: () => void
  recoveryMode?: StreamRecoveryMode
  /** Number of callable tools present on this exact prepared request. */
  availableToolCount?: number
}

interface WrappedSdkStream {
  response: any
  closeRaw: () => Promise<void>
  /** Whether a `metadataEvent.tokenUsage` event was seen so far on this attempt. */
  completionMetadataSeen: () => boolean
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The request was aborted', 'AbortError')
}

async function closeIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  try {
    await iterator.return?.()
  } catch {}
}

function isCompletionMetadataEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null || !('metadataEvent' in event)) return false
  const metadata = event.metadataEvent
  if (typeof metadata !== 'object' || metadata === null || !('tokenUsage' in metadata)) return false
  return typeof metadata.tokenUsage === 'object' && metadata.tokenUsage !== null
}

function wrapSdkEventStream(
  sdkResponse: any,
  signal?: AbortSignal,
  onUpstreamWaitStart?: (context: { eventIndex: number }) => void,
  onUpstreamWaitEnd?: () => void,
  onIterationError?: (error: unknown, afterCompletionMetadata: boolean) => void
): WrappedSdkStream {
  const eventStream = sdkResponse.generateAssistantResponseResponse
  if (!eventStream || typeof eventStream[Symbol.asyncIterator] !== 'function') {
    return { response: sdkResponse, closeRaw: async () => {}, completionMetadataSeen: () => false }
  }

  const rawIterator = eventStream[Symbol.asyncIterator]() as AsyncIterator<unknown>
  let closed = false
  let completionMetadataSeen = false
  let eventIndex = 0
  const closeRaw = async (): Promise<void> => {
    if (closed) return
    closed = true
    await closeIterator(rawIterator)
  }

  const nextRaw = async (): Promise<IteratorResult<unknown>> => {
    if (signal?.aborted) {
      await closeRaw()
      throw abortReason(signal)
    }

    onUpstreamWaitStart?.({ eventIndex })
    try {
      let result: IteratorResult<unknown>
      if (!signal) {
        result = await rawIterator.next()
      } else {
        result = await new Promise<IteratorResult<unknown>>((resolve, reject) => {
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
            (nextResult) => settle(() => resolve(nextResult)),
            (error) => settle(() => reject(error))
          )
        })
      }
      if (!result.done) eventIndex++
      return result
    } finally {
      onUpstreamWaitEnd?.()
    }
  }

  const wrappedIterator: AsyncIterator<unknown> = {
    async next() {
      try {
        const result = await nextRaw()
        if (!result.done && isCompletionMetadataEvent(result.value)) {
          completionMetadataSeen = true
        }
        return result
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal)
        onIterationError?.(error, completionMetadataSeen)
        if (completionMetadataSeen) {
          await closeRaw()
          return { done: true, value: undefined }
        }
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
    closeRaw,
    completionMetadataSeen: () => completionMetadataSeen
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

export function encodeSseChunk(chunk: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
}

class SemanticStreamTruncationError extends Error {
  readonly name = 'SemanticStreamTruncationError'

  constructor() {
    super('Kiro SDK event stream ended with an unclosed tool intent')
  }
}

function isSemanticTruncation(
  mode: StreamRecoveryMode,
  observer: StreamObserver | undefined
): boolean {
  return mode !== 'off' && observer?.hasOpenToolIntent === true
}

function noteStreamFailure(lifecycle: SdkResponseLifecycle, error: unknown): void {
  if (lifecycle.signal?.aborted) {
    lifecycle.streamObserver?.noteTerminalSource('caller_abort')
  } else if (error instanceof SdkEventStreamIterationError) {
    lifecycle.streamObserver?.noteTerminalSource('iterator_failure')
  } else {
    lifecycle.streamObserver?.noteTerminalSource('stream_processing_failure')
  }
}

function bufferedSseResponse(chunks: Uint8Array[]): Response {
  let index = 0
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[index++]
          if (chunk) controller.enqueue(chunk)
          if (index >= chunks.length) controller.close()
        }
      },
      { highWaterMark: 0 }
    ),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
}

export class ResponseHandler {
  private async fireCompletion(
    lifecycle: SdkResponseLifecycle,
    reasoning: ReasoningAccumulator,
    emitted: EmittedOutputAccumulator,
    model: string,
    recovered: boolean
  ): Promise<void> {
    if (!lifecycle.onComplete) return
    const toolUses = emitted.toolUses()
    const envelope = reasoning.finalize()
    const resolved = resolveLoop(lifecycle.inheritedLoopId, toolUses)
    await lifecycle.onComplete({
      ...(envelope !== undefined ? { envelope } : {}),
      reasoningText: emitted.reasoningText,
      visibleText: emitted.visibleText,
      toolUses,
      attemptId: lifecycle.attemptId ?? '',
      ...(resolved.loopId !== undefined ? { loopId: resolved.loopId } : {}),
      effectiveModel: lifecycle.effectiveModel ?? model,
      recovered
    })
  }

  async prepareSdkStreamingAttempt(input: SdkStreamingAttemptInput): Promise<SdkStreamingAttempt> {
    const { sdkResponse, model, conversationId, lifecycle, recoveryMode } = input
    const wrapped = wrapSdkEventStream(
      sdkResponse,
      lifecycle.signal,
      lifecycle.onUpstreamWaitStart,
      lifecycle.onUpstreamWaitEnd,
      lifecycle.onIterationError
    )
    const reasoning = new ReasoningAccumulator()
    const emitted = lifecycle.emittedOutput ?? new EmittedOutputAccumulator()
    const transformed = transformSdkStream(
      wrapped.response,
      model,
      conversationId,
      reasoning,
      lifecycle.streamObserver,
      recoveryMode !== 'off'
    )
    const prefetched: unknown[] = []
    let prefetchIndex = 0
    let drained = false
    let closed = false

    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      await Promise.allSettled([transformed.return(undefined)])
      await wrapped.closeRaw()
    }
    const readNext = async (): Promise<IteratorResult<unknown>> => {
      if (drained) return { done: true, value: undefined }
      let item: IteratorResult<unknown>
      try {
        item = await transformed.next()
      } catch (error) {
        noteStreamFailure(lifecycle, error)
        throw error
      }
      if (item.done) {
        const completionMetadataSeen = wrapped.completionMetadataSeen()
        const semanticTruncation = isSemanticTruncation(recoveryMode, lifecycle.streamObserver)
        lifecycle.streamObserver?.noteTerminalSource(
          semanticTruncation
            ? 'semantic_truncation'
            : completionMetadataSeen
              ? 'completion_metadata_received'
              : 'clean_eof_without_completion_metadata'
        )
        if (!completionMetadataSeen) lifecycle.onCleanEofWithoutCompletionMetadata?.()
        if (semanticTruncation) {
          throw new SdkEventStreamIterationError(new SemanticStreamTruncationError())
        }
        drained = true
        return { done: true, value: undefined }
      }
      emitted.observeChunk(item.value)
      return item
    }

    try {
      while (true) {
        const item = await readNext()
        if (item.done) break
        prefetched.push(item.value)
        if (isSemanticChunk(item.value)) break
      }
    } catch (error) {
      await close()
      throw error
    }

    return {
      chunks: {
        next: async () => {
          if (prefetchIndex < prefetched.length) {
            const prefetchedChunk = prefetched[prefetchIndex]
            prefetchIndex++
            return { done: false, value: prefetchedChunk }
          }
          return readNext()
        },
        return: async () => {
          await close()
          return { done: true, value: undefined }
        }
      },
      observed: () => {
        const observed = lifecycle.streamObserver?.snapshot()
        const toolCount = emitted.toolUses().length
        const availableToolCount = lifecycle.availableToolCount ?? 0
        return {
          emitted: {
            visibleChars: emitted.visibleText.length,
            toolCount
          },
          sawToolIntent: observed?.sawToolIntent ?? false,
          terminalSource: observed?.terminalSource ?? null,
          availableToolCount,
          forwardActionCommitment:
            availableToolCount > 0 && toolCount === 0 && observed?.sawToolIntent !== true
              ? detectForwardActionCommitment(emitted.visibleText)
              : null
        }
      },
      close,
      complete: (completion) =>
        this.fireCompletion(
          lifecycle,
          reasoning,
          emitted,
          model,
          completion.recoveryTier === 'reasoning_restart'
        )
    }
  }

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
    return this.handleSdkNonStreaming(sdkResponse, model, conversationId, lifecycle)
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
    const wrapped = wrapSdkEventStream(
      sdkResponse,
      lifecycle.signal,
      lifecycle.onUpstreamWaitStart,
      lifecycle.onUpstreamWaitEnd,
      lifecycle.onIterationError
    )
    const reasoning = new ReasoningAccumulator()
    const emitted = lifecycle.emittedOutput ?? new EmittedOutputAccumulator()
    const transformed = transformSdkStream(
      wrapped.response,
      model,
      conversationId,
      reasoning,
      lifecycle.streamObserver,
      (lifecycle.recoveryMode ?? 'off') !== 'off'
    )
    const buffered: Uint8Array[] = []
    const nextTransformed = async (): Promise<IteratorResult<unknown>> => {
      try {
        return await transformed.next()
      } catch (error) {
        noteStreamFailure(lifecycle, error)
        throw error
      }
    }
    // One shared publication point for all three completion paths. Duplicating it
    // per site is how the live pull-driven path silently stops populating. It is
    // also the only place a clean `done` is observable, so the missing-completion
    // marker fires here, before completion, rather than at each `item.done`.
    const complete = async (): Promise<void> => {
      const completionMetadataSeen = wrapped.completionMetadataSeen()
      const semanticTruncation = isSemanticTruncation(
        lifecycle.recoveryMode ?? 'off',
        lifecycle.streamObserver
      )
      lifecycle.streamObserver?.noteTerminalSource(
        semanticTruncation
          ? 'semantic_truncation'
          : completionMetadataSeen
            ? 'completion_metadata_received'
            : 'clean_eof_without_completion_metadata'
      )
      if (!completionMetadataSeen) lifecycle.onCleanEofWithoutCompletionMetadata?.()
      if (semanticTruncation) {
        throw new SdkEventStreamIterationError(new SemanticStreamTruncationError())
      }
      return this.fireCompletion(lifecycle, reasoning, emitted, model, false)
    }

    if (lifecycle.bufferUntilComplete) {
      try {
        while (true) {
          const item = await nextTransformed()
          if (item.done) {
            await complete()
            lifecycle.onTerminal?.()
            return bufferedSseResponse(buffered)
          }
          emitted.observeChunk(item.value)
          buffered.push(encodeSseChunk(item.value))
        }
      } catch (error) {
        try {
          await transformed.return(undefined)
        } catch {}
        await wrapped.closeRaw()
        throw error
      }
    }

    let firstSemantic: Uint8Array | undefined

    while (true) {
      const item = await nextTransformed()
      if (item.done) {
        await complete()
        lifecycle.onTerminal?.()
        return bufferedSseResponse(buffered)
      }

      emitted.observeChunk(item.value)
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
              lifecycle.streamObserver?.noteTerminalSource('caller_abort')
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
              const item = await nextTransformed()
              if (item.done) {
                await complete()
                finish()
                controller.close()
                return
              }
              emitted.observeChunk(item.value)
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
            lifecycle.streamObserver?.noteTerminalSource('caller_abort')
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
    lifecycle: SdkResponseLifecycle
  ): Promise<Response> {
    // For non-streaming SDK responses, collect all events
    let content = ''
    let reasoningContent = ''
    const toolCalls: any[] = []
    let inputTokens = 0
    let outputTokens = 0

    const wrapped = wrapSdkEventStream(
      sdkResponse,
      lifecycle.signal,
      lifecycle.onUpstreamWaitStart,
      lifecycle.onUpstreamWaitEnd,
      lifecycle.onIterationError
    )
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
            inputTokens = event.metadataEvent.tokenUsage.uncachedInputTokens || 0
            outputTokens = event.metadataEvent.tokenUsage.outputTokens || 0
          }
        }
      } finally {
        if (lifecycle.signal?.aborted) await wrapped.closeRaw()
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
