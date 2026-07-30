import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

// §6.8: a signature or a redacted byte must never reach a log file or a thrown error.
// Redaction lives in the log SINKS (`writeApiLog`, `writeToFile`), not in the call sites,
// so it is structural: no future caller can leak a signature by logging a prepared
// request, a conversationState, or a whole history for debugging. Measured at `18c27ba`:
// the then-current call sites happened not to leak, but passing `conversationState` to
// either sink wrote the raw 324-char signature verbatim into both log files.

const SHA256_PREFIX_LENGTH = 12
const MAX_DEPTH = 16

/** Key whose object value is a Kiro reasoning envelope in either wire or internal form. */
const REASONING_CONTENT_KEY = 'reasoningContent'
/** Key whose string value is a Bedrock thinking-block signature. */
const SIGNATURE_KEY = 'signature'
/** Key whose binary value is an opaque redacted reasoning payload. */
const REDACTED_CONTENT_KEY = 'redactedContent'

export interface RedactedSignature {
  present: true
  length: number
  sha256Prefix: string
}

export interface RedactedBytes {
  present: true
  byteLength: number
  sha256Prefix: string
}

export interface RedactedReasoningText {
  textLength: number
  textSha256Prefix: string
  signature: RedactedSignature | { present: false }
}

export interface RedactedReasoningEnvelope {
  redacted: true
  kind: 'reasoningText' | 'redactedContent' | 'unknown'
  reasoningText?: RedactedReasoningText
  redactedContent?: RedactedBytes
}

/** Short digest prefix — enough to correlate two log lines, useless for replay. */
export function sha256Prefix(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
  return createHash('sha256').update(bytes).digest('hex').slice(0, SHA256_PREFIX_LENGTH)
}

export function describeSignatureForLog(signature: string): RedactedSignature {
  return { present: true, length: signature.length, sha256Prefix: sha256Prefix(signature) }
}

export function describeRedactedBytesForLog(bytes: Uint8Array): RedactedBytes {
  return { present: true, byteLength: bytes.byteLength, sha256Prefix: sha256Prefix(bytes) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeReasoningText(value: unknown): RedactedReasoningText {
  const text = isRecord(value) && typeof value.text === 'string' ? value.text : ''
  const signature =
    isRecord(value) && typeof value.signature === 'string' && value.signature.length > 0
      ? describeSignatureForLog(value.signature)
      : ({ present: false } as const)
  return { textLength: text.length, textSha256Prefix: sha256Prefix(text), signature }
}

/**
 * Collapses a reasoning envelope — the nested wire form
 * `{reasoningText:{text,signature}}` / `{redactedContent}` or the internal
 * `{kind,text,signature}` / `{kind,bytes}` form — into lengths and digest prefixes.
 */
export function describeReasoningContentForLog(value: unknown): RedactedReasoningEnvelope {
  if (!isRecord(value)) return { redacted: true, kind: 'unknown' }

  const nestedText = value.reasoningText
  if (isRecord(nestedText)) {
    return {
      redacted: true,
      kind: 'reasoningText',
      reasoningText: describeReasoningText(nestedText)
    }
  }

  const nestedBytes = value.redactedContent
  if (nestedBytes instanceof Uint8Array) {
    return {
      redacted: true,
      kind: 'redactedContent',
      redactedContent: describeRedactedBytesForLog(nestedBytes)
    }
  }

  // Internal `KiroReasoningContent` shape.
  if (value.kind === 'reasoningText') {
    return { redacted: true, kind: 'reasoningText', reasoningText: describeReasoningText(value) }
  }
  if (value.kind === 'redactedContent' && value.bytes instanceof Uint8Array) {
    return {
      redacted: true,
      kind: 'redactedContent',
      redactedContent: describeRedactedBytesForLog(value.bytes)
    }
  }

  return { redacted: true, kind: 'unknown' }
}

function redactValue(value: unknown, depth: number, path: Set<object>): unknown {
  if (depth > MAX_DEPTH) return '[max depth]'
  if (value instanceof Uint8Array) return value
  if (value instanceof Error) return value
  if (!isRecord(value) && !Array.isArray(value)) return value
  // A cycle raises the same TypeError `JSON.stringify` would have raised on the
  // original value, so both sinks keep their pre-existing unserializable behavior.
  if (path.has(value)) throw new TypeError('Converting circular structure to JSON')
  path.add(value)
  try {
    if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1, path))
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (key === REASONING_CONTENT_KEY && (isRecord(entry) || Array.isArray(entry))) {
        output[key] = Array.isArray(entry)
          ? entry.map((item) => describeReasoningContentForLog(item))
          : describeReasoningContentForLog(entry)
        continue
      }
      if (key === SIGNATURE_KEY && typeof entry === 'string') {
        output[key] = entry.length > 0 ? describeSignatureForLog(entry) : { present: false }
        continue
      }
      if (key === REDACTED_CONTENT_KEY && entry instanceof Uint8Array) {
        output[key] = describeRedactedBytesForLog(entry)
        continue
      }
      output[key] = redactValue(entry, depth + 1, path)
    }
    return output
  } finally {
    path.delete(value)
  }
}

/**
 * Deep-copies `value`, replacing every reasoning signature and every redacted byte
 * payload with a `{present, length|byteLength, sha256Prefix}` descriptor. Everything
 * else — including image bytes, which the API log intentionally base64-encodes — is
 * passed through untouched. Throws on a circular structure, exactly as
 * `JSON.stringify` would.
 */
export function redactReasoningForLog(value: unknown): unknown {
  return redactValue(value, 0, new Set<object>())
}
