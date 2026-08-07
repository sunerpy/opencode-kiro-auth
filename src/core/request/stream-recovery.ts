/**
 * Coordinates one outbound SSE byte stream across transformed OpenAI-chunk iterators from
 * multiple SDK attempts. Attempts stay pre-SSE-encoding so each attempt keeps its own
 * transformer, EmittedOutputAccumulator, and StreamObserver; the caller injects the existing
 * SSE encoder at the sole publication point. A terminal chunk and every chunk after it are
 * withheld until that attempt drains cleanly, preventing failed attempts from publishing a
 * synthetic success before recovery starts.
 */

import { EmittedOutputAccumulator } from '../../plugin/reasoning/emitted-output.js'
import type { StreamTerminalSource } from '../../plugin/streaming/stream-observer.js'
import type { ForwardActionCommitmentKind } from './action-commitment.js'
import {
  ExactReplayMatcher,
  type ReplayDivergenceChannel,
  type ReplayMatchProgress
} from './replay-matcher.js'

export type StreamRecoveryMode = 'off' | 'reasoning_restart' | 'exact_replay'

export type RecoveryTier = 'reasoning_restart' | 'exact_replay' | 'none'

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
  readonly terminalSource?: StreamTerminalSource | null
  readonly availableToolCount?: number
  readonly forwardActionCommitment?: ForwardActionCommitmentKind | null
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
  readonly recoveryTier: RecoveryTier
  readonly recovered: boolean
}

export type ReplayAttemptTelemetry = ReplayMatchProgress & {
  readonly divergenceChannel: ReplayDivergenceChannel
  readonly replayOutcome: 'caught_up' | 'diverged' | 'failed'
  readonly attempts: number
}

export type ActionCommitmentRetryTelemetry = {
  readonly attemptIndex: number
  readonly pattern: ForwardActionCommitmentKind
  readonly visibleChars: number
  readonly availableToolCount: number
}

export type StreamRecoveryTerminationReason =
  | 'completed'
  | 'caller_abort'
  | 'consumer_cancel'
  | 'recovery_unavailable'
  | 'attempt_budget_exhausted'
  | 'coordinator_failure'

export type StreamRecoveryOptions = {
  readonly mode: StreamRecoveryMode
  readonly maxAttempts: number
  readonly signal: AbortSignal
  /** Already primed through the first semantic chunk so pre-output failures stay caller-owned. */
  readonly initialAttempt?: AttemptHandle
  readonly attemptFactory: AttemptFactory
  /** Receives the one-based index and cause of the failed attempt being backed off. */
  readonly delayFn: (attemptIndex: number, signal: AbortSignal, failure: Error) => Promise<void>
  readonly mapError: (failure: unknown) => Error
  readonly encodeChunk: (chunk: unknown) => Uint8Array
  readonly onComplete: (completion: StreamRecoveryCompletion) => void | Promise<void>
  readonly onTerminal: (reason: StreamRecoveryTerminationReason) => void
  readonly onCancel?: (reason: unknown) => void
  readonly onReplayAttempt?: (telemetry: ReplayAttemptTelemetry, failure?: Error) => void
  readonly onActionCommitmentRetry?: (
    telemetry: ActionCommitmentRetryTelemetry
  ) => void | Promise<void>
}

export function decideRecoveryTier(input: RecoveryDecisionInput): RecoveryTier {
  const reasoningRestartEligible =
    input.emitted.visibleChars === 0 && input.emitted.toolCount === 0 && !input.sawToolIntent
  switch (input.mode) {
    case 'off':
      return 'none'
    case 'reasoning_restart':
      return reasoningRestartEligible ? 'reasoning_restart' : 'none'
    case 'exact_replay':
      if (reasoningRestartEligible) return 'reasoning_restart'
      return input.emitted.visibleChars > 0 || input.emitted.toolCount > 0 ? 'exact_replay' : 'none'
    default:
      return assertNever(input.mode)
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected stream recovery mode: ${String(value)}`)
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

class ReplayDivergenceError extends Error {
  override readonly name = 'ReplayDivergenceError'

  constructor(readonly channel: Exclude<ReplayDivergenceChannel, 'none'>) {
    super(`Exact replay diverged in the ${channel} channel`)
  }
}

export class StreamRecoveryCoordinator {
  readonly stream: ReadableStream<Uint8Array>

  private readonly options: StreamRecoveryOptions
  private activeAttempt: AttemptHandle | undefined
  private attemptIndex = 0
  private readonly delivered = new EmittedOutputAccumulator()
  private sawToolIntent = false
  private activeRecoveryTier: RecoveryTier = 'none'
  private replayMatcher: ExactReplayMatcher | undefined
  private actionCommitmentRetryUsed = false
  private actionCommitmentReplayPending = false
  private terminal = false
  private completionFired = false
  private abortListener: (() => void) | undefined
  private readonly pendingTerminalChunks: unknown[] = []
  private readonly pendingDeliveryChunks: unknown[] = []

  constructor(options: StreamRecoveryOptions) {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new RangeError('maxAttempts must be a positive integer')
    }
    this.options = options
    if (options.initialAttempt) {
      this.activeAttempt = options.initialAttempt
      this.attemptIndex = 1
    }
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
      this.finish('caller_abort')
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
      this.finish('coordinator_failure')
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

      const pending = this.pendingDeliveryChunks.shift()
      if (pending !== undefined) {
        if (this.publishChunk(pending, controller)) return
        continue
      }

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
        if (this.replayMatcher) {
          const failure = new ReplayDivergenceError('early_end')
          this.reportReplayAttempt('diverged', 'early_end', failure)
          if (!(await this.recoverOrTerminate(failure, attempt, controller))) {
            return
          }
          continue
        }
        const observation = attempt.observed()
        const actionCommitmentRetry = this.actionCommitmentRetryTelemetry(observation)
        if (actionCommitmentRetry) {
          if (!(await this.retryActionCommitment(observation, actionCommitmentRetry))) return
          continue
        }
        await this.complete(controller)
        return
      }

      const match = this.replayMatcher?.consume(item.value)
      if (match?.kind === 'withheld') continue
      if (match?.kind === 'diverged') {
        const failure = new ReplayDivergenceError(match.channel)
        this.reportReplayAttempt('diverged', match.channel, failure)
        if (!(await this.recoverOrTerminate(failure, attempt, controller))) {
          return
        }
        continue
      }
      if (match?.kind === 'release') {
        if (match.caughtUp) {
          this.actionCommitmentReplayPending = false
          this.reportReplayAttempt('caught_up', 'none')
        }
        this.pendingDeliveryChunks.push(...match.chunks)
        continue
      }
      if (this.publishChunk(item.value, controller)) return
    }
  }

  private publishChunk(
    chunk: unknown,
    controller: ReadableStreamDefaultController<Uint8Array>
  ): boolean {
    if (this.pendingTerminalChunks.length > 0 || isTerminalChunk(chunk)) {
      this.pendingTerminalChunks.push(chunk)
      return false
    }
    this.delivered.observeChunk(chunk)
    controller.enqueue(this.options.encodeChunk(chunk))
    return true
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
      if (this.replayMatcher && !this.options.signal.aborted) {
        this.reportReplayAttempt('failed', 'none', error)
      }
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
    if (this.replayMatcher && !this.options.signal.aborted) {
      this.reportReplayAttempt('failed', 'none', failure)
    }
    this.pendingTerminalChunks.length = 0
    this.pendingDeliveryChunks.length = 0
    await this.closeActiveAttempt()
    if (this.terminal) return false

    if (this.actionCommitmentReplayPending) {
      this.actionCommitmentReplayPending = false
      this.finish('recovery_unavailable')
      controller.error(this.options.mapError(failure))
      return false
    }

    const tier = decideRecoveryTier({
      mode: this.options.mode,
      emitted: {
        visibleChars: this.delivered.visibleText.length,
        toolCount: this.delivered.toolUses().length
      },
      sawToolIntent: this.sawToolIntent
    })
    if (tier === 'none' || this.attemptIndex >= this.options.maxAttempts) {
      this.finish(
        this.attemptIndex >= this.options.maxAttempts
          ? 'attempt_budget_exhausted'
          : 'recovery_unavailable'
      )
      controller.error(this.options.mapError(failure))
      return false
    }

    this.activeRecoveryTier = tier
    if (tier === 'exact_replay') {
      this.replayMatcher = new ExactReplayMatcher({
        reasoningText: this.delivered.reasoningText,
        visibleText: this.delivered.visibleText,
        toolUses: this.delivered.toolUses()
      })
    }
    await this.options.delayFn(this.attemptIndex, this.options.signal, failure)
    return !this.terminal
  }

  private actionCommitmentRetryTelemetry(
    observation: AttemptObservation
  ): ActionCommitmentRetryTelemetry | null {
    const pattern = observation.forwardActionCommitment
    const availableToolCount = observation.availableToolCount ?? 0
    if (
      this.options.mode !== 'exact_replay' ||
      this.actionCommitmentRetryUsed ||
      this.attemptIndex >= this.options.maxAttempts ||
      observation.terminalSource !== 'clean_eof_without_completion_metadata' ||
      observation.emitted.visibleChars === 0 ||
      observation.emitted.toolCount !== 0 ||
      this.delivered.toolUses().length !== 0 ||
      observation.sawToolIntent ||
      availableToolCount === 0 ||
      pattern === null ||
      pattern === undefined
    ) {
      return null
    }
    return {
      attemptIndex: this.attemptIndex,
      pattern,
      visibleChars: this.delivered.visibleText.length,
      availableToolCount
    }
  }

  private async retryActionCommitment(
    observation: AttemptObservation,
    telemetry: ActionCommitmentRetryTelemetry
  ): Promise<boolean> {
    this.actionCommitmentRetryUsed = true
    this.mergeObservation(observation)
    this.pendingTerminalChunks.length = 0
    this.pendingDeliveryChunks.length = 0
    await this.closeActiveAttempt()
    if (this.terminal) return false

    this.activeRecoveryTier = 'exact_replay'
    this.actionCommitmentReplayPending = true
    this.replayMatcher = new ExactReplayMatcher({
      reasoningText: this.delivered.reasoningText,
      visibleText: this.delivered.visibleText,
      toolUses: this.delivered.toolUses()
    })
    await this.options.onActionCommitmentRetry?.(telemetry)
    return !this.terminal
  }

  private mergeObservation(observation: AttemptObservation): void {
    this.sawToolIntent ||= observation.sawToolIntent
  }

  private reportReplayAttempt(
    replayOutcome: ReplayAttemptTelemetry['replayOutcome'],
    divergenceChannel: ReplayDivergenceChannel,
    failure?: Error
  ): void {
    const matcher = this.replayMatcher
    if (!matcher) return
    this.options.onReplayAttempt?.(
      {
        ...matcher.progress(),
        divergenceChannel,
        replayOutcome,
        attempts: this.attemptIndex
      },
      failure
    )
    this.replayMatcher = undefined
  }

  private async complete(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    const succeededAttempt = this.attemptIndex
    await this.closeActiveAttempt()
    if (this.terminal) return

    if (!this.completionFired) {
      this.completionFired = true
      await this.options.onComplete({
        attemptIndex: succeededAttempt,
        recoveryTier: this.activeRecoveryTier,
        // Tier A concatenates unrelated reasoning attempts, so its envelope cannot
        // describe the delivered output. Exact replay matched every delivered channel;
        // prefix + suffix equals the successful replay itself, making its envelope safe.
        recovered: this.activeRecoveryTier === 'reasoning_restart'
      })
    }
    if (this.terminal) return

    for (const chunk of this.pendingTerminalChunks) {
      controller.enqueue(this.options.encodeChunk(chunk))
    }
    this.pendingTerminalChunks.length = 0
    this.finish('completed')
    controller.close()
  }

  private async cancel(reason: unknown): Promise<void> {
    if (this.terminal) return
    // Let the owner abort its request signal before terminal logging runs, so a
    // consumer cancellation is recorded as caller_abort rather than a transport end.
    this.options.onCancel?.(reason)
    const closing = this.closeActiveAttempt()
    this.finish('consumer_cancel')
    await closing
  }

  private async closeActiveAttempt(): Promise<void> {
    const attempt = this.activeAttempt
    this.activeAttempt = undefined
    if (!attempt) return
    await Promise.allSettled([attempt.close()])
  }

  private finish(reason: StreamRecoveryTerminationReason): void {
    if (this.terminal) return
    this.terminal = true
    if (this.abortListener) {
      this.options.signal.removeEventListener('abort', this.abortListener)
      this.abortListener = undefined
    }
    this.options.onTerminal(reason)
  }
}
