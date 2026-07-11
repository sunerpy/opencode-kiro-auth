import {
  DSML_MARKER,
  parseTextToolCalls
} from '../../infrastructure/transformers/tool-call-parser.js'
import type { ToolCall } from '../types.js'

// Opening markers that signal a text-dialect tool call may be starting. Once
// any of these appears in the accumulated visible text, we stop streaming
// further visible text (buffer it) so a dialect span is never emitted as
// visible `delta.content`. Authoritative parsing happens only at finalization
// on the FULL accumulated text (never per-fragment).
const OPENING_MARKERS = ['<function_calls', '<invoke name=', DSML_MARKER]

const MAX_MARKER_LEN = Math.max(...OPENING_MARKERS.map((m) => m.length))

/** Earliest index of any opening marker in `text`, or -1. */
function firstMarkerIndex(text: string): number {
  let earliest = -1
  for (const marker of OPENING_MARKERS) {
    const idx = text.indexOf(marker)
    if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx
  }
  return earliest
}

/**
 * Length of the longest suffix of `text` that is a proper prefix of some
 * opening marker — i.e. the tail might be the start of a marker split across
 * chunks. That tail is reserved (not emitted yet) to avoid streaming half a
 * marker as visible text.
 */
function partialMarkerTail(text: string): number {
  const maxLook = Math.min(text.length, MAX_MARKER_LEN - 1)
  for (let len = maxLook; len > 0; len--) {
    const tail = text.slice(text.length - len)
    for (const marker of OPENING_MARKERS) {
      if (marker.length > len && marker.startsWith(tail)) return len
    }
  }
  return 0
}

/**
 * Streaming suppression gate for text-dialect tool calls.
 *
 * Visible assistant reply text is pushed through the gate as it streams. While
 * no dialect opening marker has appeared, the gate returns the safe prefix to
 * stream (holding back only a possible partial-marker tail). Once a marker
 * appears, everything from the marker onward is withheld. At finalization,
 * `finalize()` parses the full accumulated text into structured tool calls and
 * returns the remaining non-dialect text (dialect spans removed) that still
 * needs to be emitted.
 */
export class DialectGate {
  private accumulated = ''
  private emitted = 0
  private markerSeen = false

  /** Append a visible-text chunk; returns the substring safe to emit now. */
  push(text: string): string {
    if (!text) return ''
    this.accumulated += text

    if (!this.markerSeen) {
      const markerIdx = firstMarkerIndex(this.accumulated)
      if (markerIdx !== -1) this.markerSeen = true
    }

    let safeEnd: number
    if (this.markerSeen) {
      safeEnd = firstMarkerIndex(this.accumulated)
      if (safeEnd === -1) safeEnd = this.accumulated.length
    } else {
      // No marker yet — but the tail could be the start of one; reserve it.
      safeEnd = this.accumulated.length - partialMarkerTail(this.accumulated)
    }

    if (safeEnd <= this.emitted) return ''
    const out = this.accumulated.slice(this.emitted, safeEnd)
    this.emitted = safeEnd
    return out
  }

  /** True once a dialect opening marker has been observed (streaming suppressed). */
  get suppressing(): boolean {
    return this.markerSeen
  }

  /**
   * Finalize: parse the full accumulated text into structured tool calls and
   * return the non-dialect text that was buffered but not yet emitted.
   */
  finalize(): { toolCalls: ToolCall[]; remainderText: string } {
    const { toolCalls, cleanedText } = parseTextToolCalls(this.accumulated)
    // Text before the first marker was already emitted verbatim and is never
    // part of a dialect span, so cleanedText[0..emitted) == what we emitted.
    const remainderText = cleanedText.length > this.emitted ? cleanedText.slice(this.emitted) : ''
    return { toolCalls, remainderText }
  }
}
