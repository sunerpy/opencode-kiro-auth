/**
 * Where the reasoning/thinking channel stands at the moment of observation.
 *
 * - `none`   — no reasoning block has ever opened on this attempt.
 * - `active` — a reasoning block is open right now (nothing closed it yet).
 * - `ended`  — a reasoning block opened and was closed.
 */
export type ReasoningPhase = 'none' | 'active' | 'ended'

export interface StreamObservedState {
  /**
   * True once the attempt has ANY evidence of tool intent, at ingestion time —
   * long before the transformer flushes `tool_calls` at stream end. Two sources:
   * a raw `toolUseEvent` from the SDK, or a text-dialect tool marker entering
   * the dialect gate.
   */
  sawToolIntent: boolean
  /** True while a raw or dialect tool intent has not reached a valid close signal. */
  hasOpenToolIntent: boolean
  reasoningPhase: ReasoningPhase
  /** True once the dialect gate started withholding text (a marker appeared). */
  dialectActive: boolean
}

/**
 * Observes ONE stream attempt's ingestion-time signals for the recovery tier
 * decision. Observation only: the transformer never reads it back, so attaching
 * an observer cannot change a single emitted chunk.
 *
 * Read it AFTER the attempt ends — successfully or by iterator failure. The
 * whole point is that `sawToolIntent` is already true when a stream dies before
 * the transformer's end-of-stream tool flush, which is exactly the case where
 * naive replay would double-execute a tool.
 */
export class StreamObserver {
  private toolIntent = false
  private readonly openRawToolIntents = new Set<string>()
  private anonymousRawToolIntent = false
  private dialectToolIntentOpen = false
  private phase: ReasoningPhase = 'none'
  private dialect = false

  /** A raw SDK tool sequence advanced; only `stop: true` closes that sequence. */
  noteRawToolIntent(toolUseId: string | undefined, closed: boolean): void {
    this.toolIntent = true
    if (toolUseId) {
      if (closed) this.openRawToolIntents.delete(toolUseId)
      else this.openRawToolIntents.add(toolUseId)
      return
    }
    this.anonymousRawToolIntent = !closed
  }

  /** The dialect gate observed a text-dialect tool-call opening marker. */
  noteDialectToolIntent(): void {
    this.dialect = true
    this.dialectToolIntentOpen = true
    this.toolIntent = true
  }

  /** Records whether finalization resolved the observed marker into a complete call. */
  noteDialectToolResolution(hasCompleteToolCall: boolean): void {
    if (this.dialect && hasCompleteToolCall) this.dialectToolIntentOpen = false
  }

  /** A reasoning/thinking block opened (native reasoning run or inline tag). */
  noteReasoningStarted(): void {
    this.phase = 'active'
  }

  /** The open reasoning/thinking block closed. Never downgrades `none`. */
  noteReasoningEnded(): void {
    if (this.phase === 'active') this.phase = 'ended'
  }

  get sawToolIntent(): boolean {
    return this.toolIntent
  }

  get hasOpenToolIntent(): boolean {
    return (
      this.openRawToolIntents.size > 0 || this.anonymousRawToolIntent || this.dialectToolIntentOpen
    )
  }

  get reasoningPhase(): ReasoningPhase {
    return this.phase
  }

  get dialectActive(): boolean {
    return this.dialect
  }

  snapshot(): StreamObservedState {
    return {
      sawToolIntent: this.toolIntent,
      hasOpenToolIntent: this.hasOpenToolIntent,
      reasoningPhase: this.phase,
      dialectActive: this.dialect
    }
  }
}
