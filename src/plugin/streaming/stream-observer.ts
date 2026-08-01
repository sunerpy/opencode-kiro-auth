import type { DialectToolResolution } from '../../infrastructure/transformers/tool-call-parser.js'

/**
 * Where the reasoning/thinking channel stands at the moment of observation.
 *
 * - `none`   — no reasoning block has ever opened on this attempt.
 * - `active` — a reasoning block is open right now (nothing closed it yet).
 * - `ended`  — a reasoning block opened and was closed.
 */
export type ReasoningPhase = 'none' | 'active' | 'ended'
export type ObservedDialectResolution = DialectToolResolution | 'not_finalized'
export type StreamTerminalSource =
  | 'clean_eof_without_completion_metadata'
  | 'completion_metadata_received'
  | 'iterator_failure'
  | 'semantic_truncation'
  | 'caller_abort'
  | 'stream_attempt_budget_exhausted'

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
  /** Earliest raw dialect marker offset, including markers inside code examples. */
  dialectMarkerIndex: number | null
  /** Whether that marker is inside fenced/inline code; null means no marker. */
  dialectMarkerInCodeRegion: boolean | null
  /** Final parser verdict, or `not_finalized` when iteration stopped first. */
  dialectResolution: ObservedDialectResolution
  /** Counts only raw event discriminator names; event payloads are never retained. */
  eventTypeCounts: Record<string, number>
  /** The transport/parser/caller decision that ended this attempt, if reached. */
  terminalSource: StreamTerminalSource | null
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
  private rawToolIntentSeen = false
  private readonly openRawToolIntents = new Set<string>()
  private anonymousRawToolIntent = false
  private dialectToolIntentSeen = false
  private dialectToolIntentOpen = false
  private phase: ReasoningPhase = 'none'
  private dialect = false
  private markerIndex: number | null = null
  private markerInCodeRegion: boolean | null = null
  private resolution: ObservedDialectResolution = 'not_finalized'
  private readonly rawEventTypeCounts: Record<string, number> = {}
  private terminal: StreamTerminalSource | null = null

  noteRawEvent(event: unknown): void {
    if (typeof event !== 'object' || event === null) {
      this.rawEventTypeCounts.unknown = (this.rawEventTypeCounts.unknown ?? 0) + 1
      return
    }

    const record = event as Record<string, unknown>
    const eventTypes = Object.keys(record).filter(
      (key) => key.endsWith('Event') && record[key] !== undefined
    )
    if (eventTypes.length === 0) eventTypes.push('unknown')
    for (const eventType of eventTypes) {
      this.rawEventTypeCounts[eventType] = (this.rawEventTypeCounts[eventType] ?? 0) + 1
    }
  }

  /** A raw SDK tool sequence advanced; only `stop: true` closes that sequence. */
  noteRawToolIntent(toolUseId: string | undefined, closed: boolean): void {
    this.rawToolIntentSeen = true
    if (toolUseId) {
      if (closed) this.openRawToolIntents.delete(toolUseId)
      else this.openRawToolIntents.add(toolUseId)
      return
    }
    this.anonymousRawToolIntent = !closed
  }

  noteDialectGateActive(): void {
    this.dialect = true
  }

  noteDialectMarker(index: number | null, inCodeRegion: boolean | null): void {
    this.markerIndex = index
    this.markerInCodeRegion = inCodeRegion
  }

  noteTerminalSource(source: StreamTerminalSource): void {
    // Semantic truncation is more specific than the typed iterator wrapper used
    // to propagate it through the retry machinery; do not erase that decision.
    if (this.terminal === 'semantic_truncation' && source === 'iterator_failure') return
    this.terminal = source
  }

  /** Synchronize the currently observable non-code-region dialect marker. */
  noteDialectToolIntent(present: boolean): void {
    this.dialectToolIntentSeen = present
    this.dialectToolIntentOpen = present
  }

  /** Records whether finalization resolved every non-code-region opening marker. */
  noteDialectToolResolution(resolution: DialectToolResolution): void {
    this.resolution = resolution
    switch (resolution) {
      case 'none':
        this.dialectToolIntentSeen = false
        this.dialectToolIntentOpen = false
        return
      case 'complete':
        this.dialectToolIntentSeen = true
        this.dialectToolIntentOpen = false
        return
      case 'incomplete':
        this.dialectToolIntentSeen = true
        this.dialectToolIntentOpen = true
        return
    }
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
    return this.rawToolIntentSeen || this.dialectToolIntentSeen
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
      sawToolIntent: this.sawToolIntent,
      hasOpenToolIntent: this.hasOpenToolIntent,
      reasoningPhase: this.phase,
      dialectActive: this.dialect,
      dialectMarkerIndex: this.markerIndex,
      dialectMarkerInCodeRegion: this.markerInCodeRegion,
      dialectResolution: this.resolution,
      eventTypeCounts: { ...this.rawEventTypeCounts },
      terminalSource: this.terminal
    }
  }
}
