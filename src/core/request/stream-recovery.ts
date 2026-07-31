/**
 * Coordinates one outbound SSE byte stream across transformed OpenAI-chunk iterators from
 * multiple SDK attempts. Attempts stay pre-SSE-encoding so each attempt keeps its own
 * transformer, EmittedOutputAccumulator, and StreamObserver; the caller injects the existing
 * SSE encoder at the sole publication point. A terminal chunk and every chunk after it are
 * withheld until that attempt drains cleanly, preventing failed attempts from publishing a
 * synthetic success before recovery starts.
 */

export type StreamRecoveryMode = 'off' | 'reasoning_restart'

export type RecoveryTier = 'reasoning_restart' | 'none'

export type RecoveryDecisionInput = {
  readonly mode: StreamRecoveryMode
  readonly emitted: {
    readonly visibleChars: number
    readonly toolCount: number
  }
  readonly sawToolIntent: boolean
}

export type AttemptObservation = {
  readonly emitted: {
    readonly visibleChars: number
    readonly toolCount: number
  }
  readonly sawToolIntent: boolean
}

export type AttemptHandle = {
  readonly chunks: AsyncIterator<unknown>
  readonly observed: () => AttemptObservation
  readonly close: () => Promise<void>
}

export type AttemptFactory = (attemptIndex: number) => Promise<AttemptHandle>

export type StreamRecoveryCompletion = {
  /** One-based index of the attempt that drained successfully. */
  readonly attemptIndex: number
  readonly recovered: boolean
}

export type StreamRecoveryOptions = {
  readonly mode: StreamRecoveryMode
  readonly maxAttempts: number
  readonly signal: AbortSignal
  readonly attemptFactory: AttemptFactory
  /** Receives the one-based index of the failed attempt being backed off. */
  readonly delayFn: (attemptIndex: number, signal: AbortSignal) => Promise<void>
  readonly mapError: (failure: unknown) => Error
  readonly encodeChunk: (chunk: unknown) => Uint8Array
  readonly onComplete: (completion: StreamRecoveryCompletion) => void | Promise<void>
  readonly onTerminal: () => void
  readonly onCancel?: (reason: unknown) => void
}

export function decideRecoveryTier(input: RecoveryDecisionInput): RecoveryTier {
  switch (input.mode) {
    case 'off':
      return 'none'
    case 'reasoning_restart':
      return input.emitted.visibleChars === 0 &&
        input.emitted.toolCount === 0 &&
        !input.sawToolIntent
        ? 'reasoning_restart'
        : 'none'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTerminalChunk(chunk: unknown): boolean {
  if (!isRecord(chunk)) return false
  const choices = chunk['choices']
  if (!Array.isArray(choices)) return false
  const first = choices[0]
  if (!isRecord(first)) return false
  return first['finish_reason'] !== null && first['finish_reason'] !== undefined
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The request was aborted', 'AbortError')
}

function errorFrom(failure: unknown): Error {
  return failure instanceof Error
    ? failure
    : new TypeError('Stream attempt rejected with a non-Error value', { cause: failure })
}

export class StreamRecoveryCoordinator {
  readonly stream: ReadableStream<Uint8Array>

  private readonly options: StreamRecoveryOptions
  private activeAttempt: AttemptHandle | undefined
  private attemptIndex = 0
  private visibleChars = 0
  private toolCount = 0
  private sawToolIntent = false
  private terminal = false
  private completionFired = false
  private abortListener: (() => void) | undefined
  private readonly pendingTerminalChunks: unknown[] = []

  constructor(options: StreamRecoveryOptions) {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new RangeError('maxAttempts must be a positive integer')
    }
    this.options = options
    this.stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => this.start(controller),
        pull: (controller) => this.pull(controller),
        cancel: (reason) => this.cancel(reason)
      },
      { highWaterMark: 0 }
    )
  }

  private start(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.abortListener = () => {
      if (this.terminal) return
      const reason = abortReason(this.options.signal)
      this.finish()
      controller.error(reason)
      void this.closeActiveAttempt()
    }

    if (this.options.signal.aborted) this.abortListener()
    else this.options.signal.addEventListener('abort', this.abortListener, { once: true })
  }

  private async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (this.terminal) return
    try {
      await this.publishNext(controller)
    } catch (failure) {
      const error = failure instanceof Error ? failure : errorFrom(failure)
      if (this.terminal) return
      await this.closeActiveAttempt()
      if (this.terminal) return
      this.finish()
      controller.error(this.options.signal.aborted ? abortReason(this.options.signal) : error)
    }
  }

  private async publishNext(
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<void> {
    while (!this.terminal) {
      if (this.options.signal.aborted) throw abortReason(this.options.signal)

      if (!this.activeAttempt) {
        const ready = await this.openAttemptOrRecover(controller)
        if (!ready) return
      }

      const attempt = this.activeAttempt
      if (!attempt) continue

      let item: IteratorResult<unknown>
      try {
        item = await attempt.chunks.next()
      } catch (failure) {
        const error = failure instanceof Error ? failure : errorFrom(failure)
        if (!(await this.recoverOrTerminate(error, attempt, controller))) return
        continue
      }

      if (this.terminal) return
      if (item.done) {
        await this.complete(controller)
        return
      }
      if (this.pendingTerminalChunks.length > 0 || isTerminalChunk(item.value)) {
        this.pendingTerminalChunks.push(item.value)
        continue
      }

      controller.enqueue(this.options.encodeChunk(item.value))
      return
    }
  }

  private async openAttemptOrRecover(
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<boolean> {
    this.attemptIndex++
    try {
      const attempt = await this.options.attemptFactory(this.attemptIndex)
      if (this.terminal || this.options.signal.aborted) {
        await Promise.allSettled([attempt.close()])
        return false
      }
      this.activeAttempt = attempt
      return true
    } catch (failure) {
      const error = failure instanceof Error ? failure : errorFrom(failure)
      return this.recoverOrTerminate(error, undefined, controller)
    }
  }

  private async recoverOrTerminate(
    failure: Error,
    failedAttempt: AttemptHandle | undefined,
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<boolean> {
    if (this.terminal) return false
    if (failedAttempt) this.mergeObservation(failedAttempt.observed())
    this.pendingTerminalChunks.length = 0
    await this.closeActiveAttempt()
    if (this.terminal) return false

    const tier = decideRecoveryTier({
      mode: this.options.mode,
      emitted: { visibleChars: this.visibleChars, toolCount: this.toolCount },
      sawToolIntent: this.sawToolIntent
    })
    if (tier === 'none' || this.attemptIndex >= this.options.maxAttempts) {
      this.finish()
      controller.error(this.options.mapError(failure))
      return false
    }

    await this.options.delayFn(this.attemptIndex, this.options.signal)
    return !this.terminal
  }

  private mergeObservation(observation: AttemptObservation): void {
    this.visibleChars += observation.emitted.visibleChars
    this.toolCount += observation.emitted.toolCount
    this.sawToolIntent ||= observation.sawToolIntent
  }

  private async complete(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    const succeededAttempt = this.attemptIndex
    await this.closeActiveAttempt()
    if (this.terminal) return

    if (!this.completionFired) {
      this.completionFired = true
      await this.options.onComplete({
        attemptIndex: succeededAttempt,
        recovered: succeededAttempt > 1
      })
    }
    if (this.terminal) return

    for (const chunk of this.pendingTerminalChunks) {
      controller.enqueue(this.options.encodeChunk(chunk))
    }
    this.pendingTerminalChunks.length = 0
    this.finish()
    controller.close()
  }

  private async cancel(reason: unknown): Promise<void> {
    if (this.terminal) return
    const closing = this.closeActiveAttempt()
    this.finish()
    this.options.onCancel?.(reason)
    await closing
  }

  private async closeActiveAttempt(): Promise<void> {
    const attempt = this.activeAttempt
    this.activeAttempt = undefined
    if (!attempt) return
    await Promise.allSettled([attempt.close()])
  }

  private finish(): void {
    if (this.terminal) return
    this.terminal = true
    if (this.abortListener) {
      this.options.signal.removeEventListener('abort', this.abortListener)
      this.abortListener = undefined
    }
    this.options.onTerminal()
  }
}
