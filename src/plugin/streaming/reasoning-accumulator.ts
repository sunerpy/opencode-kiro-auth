import { warn } from '../logger.js'
import type { KiroReasoningContent } from '../types.js'

export interface ReasoningContentEventLike {
  text?: string | undefined
  signature?: string | undefined
  redactedContent?: Uint8Array | undefined
}

export type ReasoningEnvelopeRejection = 'conflicting-signature' | 'mixed-text-and-redacted'

export interface ReasoningAccumulatorSnapshot {
  textLength: number
  textEventCount: number
  signaturePresent: boolean
  signatureLength: number
  signatureEventCount: number
  redactedByteLength: number
  redactedEventCount: number
  rejection?: ReasoningEnvelopeRejection
}

// Observes the `reasoningContentEvent`s of ONE stream attempt and finalizes them into a
// sendable envelope. Observation only — it never influences visible output.
export class ReasoningAccumulator {
  private text = ''
  private signature = ''
  private redacted: Uint8Array | null = null
  private textEventCount = 0
  private signatureEventCount = 0
  private redactedEventCount = 0
  private rejection: ReasoningEnvelopeRejection | null = null

  observe(event: ReasoningContentEventLike | null | undefined): void {
    if (!event) return

    if (typeof event.text === 'string' && event.text.length > 0) {
      this.text += event.text
      this.textEventCount++
    }

    if (typeof event.signature === 'string' && event.signature.length > 0) {
      this.signatureEventCount++
      // Two differing non-empty signatures cover two different reasoning payloads, so
      // either choice would be a guess. Retain the last one but mark the envelope dead.
      if (this.signature.length > 0 && this.signature !== event.signature) {
        this.rejection = 'conflicting-signature'
      }
      this.signature = event.signature
    }

    const redactedContent = event.redactedContent
    if (redactedContent && redactedContent.byteLength > 0) {
      this.redactedEventCount++
      this.redacted = concatBytes(this.redacted, redactedContent)
    }
  }

  reset(): void {
    this.text = ''
    this.signature = ''
    this.redacted = null
    this.textEventCount = 0
    this.signatureEventCount = 0
    this.redactedEventCount = 0
    this.rejection = null
  }

  snapshot(): ReasoningAccumulatorSnapshot {
    const snapshot = this.sanitizedShape()
    const rejection = this.resolveRejection()
    if (rejection) snapshot.rejection = rejection
    return snapshot
  }

  finalize(): KiroReasoningContent | undefined {
    const rejection = this.resolveRejection()
    if (rejection) {
      warn('Kiro reasoning envelope unsupported, no native reasoningContent captured', {
        reason: rejection,
        ...this.sanitizedShape()
      })
      return undefined
    }

    if (this.redacted) {
      return { kind: 'redactedContent', bytes: copyBytes(this.redacted) }
    }
    // Unsigned reasoning is not a fault — some models emit none. It has no sendable form,
    // so it degrades silently to visible text only.
    if (this.text.length > 0 && this.signature.length > 0) {
      return { kind: 'reasoningText', text: this.text, signature: this.signature }
    }
    return undefined
  }

  private resolveRejection(): ReasoningEnvelopeRejection | null {
    if (this.rejection) return this.rejection
    if (this.text.length > 0 && this.redacted) return 'mixed-text-and-redacted'
    return null
  }

  // Kinds and lengths only. A signature or redacted byte must never reach a log.
  private sanitizedShape(): ReasoningAccumulatorSnapshot {
    return {
      textLength: this.text.length,
      textEventCount: this.textEventCount,
      signaturePresent: this.signature.length > 0,
      signatureLength: this.signature.length,
      signatureEventCount: this.signatureEventCount,
      redactedByteLength: this.redacted?.byteLength ?? 0,
      redactedEventCount: this.redactedEventCount
    }
  }
}

function copyBytes(source: Uint8Array): Uint8Array {
  const copy = new Uint8Array(source.byteLength)
  copy.set(source)
  return copy
}

function concatBytes(existing: Uint8Array | null, next: Uint8Array): Uint8Array {
  if (!existing) return copyBytes(next)
  const merged = new Uint8Array(existing.byteLength + next.byteLength)
  merged.set(existing, 0)
  merged.set(next, existing.byteLength)
  return merged
}
