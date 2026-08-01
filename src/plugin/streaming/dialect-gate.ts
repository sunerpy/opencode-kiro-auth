import type { DialectToolResolution } from '../../infrastructure/transformers/tool-call-parser.js'
import {
  observeTextToolCallOpeningMarker,
  parseTextToolCalls,
  TEXT_TOOL_CALL_OPENING_MARKERS
} from '../../infrastructure/transformers/tool-call-parser.js'
import type { ToolCall } from '../types.js'

// Opening markers that signal a text-dialect tool call may be starting. Once
// any of these appears in the accumulated visible text, we stop streaming
// further visible text (buffer it) so a dialect span is never emitted as
// visible `delta.content`. Authoritative parsing happens only at finalization
// on the FULL accumulated text (never per-fragment).
const MAX_MARKER_LEN = Math.max(...TEXT_TOOL_CALL_OPENING_MARKERS.map((marker) => marker.length))

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
    for (const marker of TEXT_TOOL_CALL_OPENING_MARKERS) {
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
  private toolIntentPresent = false
  private observedMarkerIndex: number | null = null
  private observedMarkerInCodeRegion: boolean | null = null

  /** Append a visible-text chunk; returns the substring safe to emit now. */
  push(text: string): string {
    if (!text) return ''
    this.accumulated += text

    // The shared scanner provisionally extends an unclosed fence through the
    // current end-of-text. Appending a close can only end that range after an
    // already-seen in-fence marker, so W-B1 guarantees such a marker remains
    // parser-inert and is safe to publish. A lone unclosed inline backtick is
    // deliberately not a code region; that case stays withheld until a closing
    // backtick proves the span is inline code.
    const marker = observeTextToolCallOpeningMarker(this.accumulated)
    const markerIdx = marker.executableIndex
    this.observedMarkerIndex = marker.index
    this.observedMarkerInCodeRegion = marker.inCodeRegion
    if (!this.markerSeen) {
      if (markerIdx !== -1) this.markerSeen = true
    }
    this.toolIntentPresent = markerIdx !== -1

    let safeEnd: number
    if (this.markerSeen) {
      safeEnd = markerIdx
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

  get hasToolIntent(): boolean {
    return this.toolIntentPresent
  }

  get markerIndex(): number | null {
    return this.observedMarkerIndex
  }

  get markerInCodeRegion(): boolean | null {
    return this.observedMarkerInCodeRegion
  }

  /**
   * Finalize: parse the full accumulated text into structured tool calls and
   * return the non-dialect text that was buffered but not yet emitted.
   */
  finalize(): {
    toolCalls: ToolCall[]
    remainderText: string
    resolution: DialectToolResolution
  } {
    const { toolCalls, cleanedText, resolution } = parseTextToolCalls(this.accumulated)
    // Every emitted byte is either before the first executable marker or inside
    // a code region the parser preserves, so cleanedText[0..emitted) remains
    // exactly what was already published.
    const remainderText = cleanedText.length > this.emitted ? cleanedText.slice(this.emitted) : ''
    return { toolCalls, remainderText, resolution }
  }
}
