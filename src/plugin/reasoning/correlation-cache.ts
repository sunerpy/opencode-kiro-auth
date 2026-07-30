import { warn } from '../logger.js'
import type { KiroReasoningContent } from '../types.js'
import { computeFingerprintKey, type FingerprintInput } from './turn-identity.js'

/**
 * In-process correlation cache for signed reasoning envelopes.
 *
 * Bounded best-effort only: a miss is indistinguishable from the behavior before
 * this cache existed, so the worst case is zero regression. A FALSE HIT is much
 * worse than a miss — the server silently accepts (HTTP 200) a signature paired
 * with the wrong turn — so every ambiguity resolves to "do not replay".
 *
 * Never persisted, never shared across processes.
 */

export const DEFAULT_MAX_ENTRIES = 64
export const DEFAULT_MAX_ENTRIES_PER_LOOP = 16
export const DEFAULT_TTL_MS = 30 * 60 * 1000

export interface ReasoningEnvelopeMetadata {
  /** Recorded for diagnostics and eviction ONLY. Never part of the lookup key. */
  accountId: string
  attemptId: string
  loopId: string
  capturedAt: number
}

export interface CachedEnvelope {
  envelope: KiroReasoningContent
  metadata: ReasoningEnvelopeMetadata
}

interface CacheEntry extends CachedEnvelope {
  key: string
  expiresAt: number
}

export interface PublishInput extends FingerprintInput {
  envelope: KiroReasoningContent
  loopId: string
  accountId: string
  attemptId: string
}

export type LookupRefusal = 'miss' | 'ambiguous'

export interface LookupResult {
  envelope?: KiroReasoningContent
  metadata?: ReasoningEnvelopeMetadata
  refusal?: LookupRefusal
}

export interface ReasoningCorrelationCacheOptions {
  maxEntries?: number
  maxEntriesPerLoop?: number
  ttlMs?: number
  now?: () => number
}

function sameEnvelope(a: KiroReasoningContent, b: KiroReasoningContent): boolean {
  if (a.kind === 'reasoningText' && b.kind === 'reasoningText') {
    return a.text === b.text && a.signature === b.signature
  }
  if (a.kind === 'redactedContent' && b.kind === 'redactedContent') {
    if (a.bytes.byteLength !== b.bytes.byteLength) return false
    for (let i = 0; i < a.bytes.byteLength; i++) {
      if (a.bytes[i] !== b.bytes[i]) return false
    }
    return true
  }
  return false
}

function isSameCapture(a: CacheEntry, b: CacheEntry): boolean {
  return (
    a.metadata.loopId === b.metadata.loopId &&
    a.metadata.accountId === b.metadata.accountId &&
    sameEnvelope(a.envelope, b.envelope)
  )
}

export class ReasoningCorrelationCache {
  // Insertion order IS the LRU order: a read re-inserts, so the oldest key is first.
  private entries = new Map<string, CacheEntry[]>()
  private readonly maxEntries: number
  private readonly maxEntriesPerLoop: number
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: ReasoningCorrelationCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxEntriesPerLoop = options.maxEntriesPerLoop ?? DEFAULT_MAX_ENTRIES_PER_LOOP
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? Date.now
  }

  get size(): number {
    let total = 0
    for (const bucket of this.entries.values()) total += bucket.length
    return total
  }

  sizeForLoop(loopId: string): number {
    let total = 0
    for (const bucket of this.entries.values()) {
      for (const entry of bucket) if (entry.metadata.loopId === loopId) total++
    }
    return total
  }

  publish(input: PublishInput): void {
    const key = computeFingerprintKey(input)
    const capturedAt = this.now()
    const entry: CacheEntry = {
      key,
      envelope: input.envelope,
      metadata: {
        accountId: input.accountId,
        attemptId: input.attemptId,
        loopId: input.loopId,
        capturedAt
      },
      expiresAt: capturedAt + this.ttlMs
    }

    const bucket = this.entries.get(key)
    if (!bucket) {
      this.entries.set(key, [entry])
    } else {
      // Re-publishing a byte-identical capture from the same account and loop is
      // a repeated turn, not ambiguity: replace in place so an idempotent
      // re-publication cannot manufacture a two-candidate refusal.
      const existingIndex = bucket.findIndex((candidate) => isSameCapture(candidate, entry))
      if (existingIndex >= 0) bucket.splice(existingIndex, 1, entry)
      else bucket.push(entry)
      this.entries.delete(key)
      this.entries.set(key, bucket)
    }

    this.enforceLoopBound(input.loopId)
    this.enforceGlobalBound()
  }

  /** Non-consuming: one envelope may legitimately match many replayed turns. */
  lookup(input: FingerprintInput): LookupResult {
    const key = computeFingerprintKey(input)
    this.purgeExpired()
    const bucket = this.entries.get(key)
    if (!bucket || bucket.length === 0) return { refusal: 'miss' }

    const distinct = bucket.filter(
      (entry, index) =>
        bucket.findIndex((other) => sameEnvelope(other.envelope, entry.envelope)) === index
    )
    if (distinct.length > 1) {
      // Includes candidates differing ONLY by producing account. Preferring the
      // current account would be a guess, and a wrong guess is silently accepted.
      warn('Kiro reasoning correlation refused: ambiguous fingerprint match', {
        candidates: bucket.length,
        distinctEnvelopes: distinct.length
      })
      return { refusal: 'ambiguous' }
    }

    const entry = bucket[0]
    if (!entry) return { refusal: 'miss' }
    this.entries.delete(key)
    this.entries.set(key, bucket)
    return { envelope: entry.envelope, metadata: entry.metadata }
  }

  /** Teardown for exactly one loop. Never a global sweep. */
  clearLoop(loopId: string): void {
    for (const [key, bucket] of [...this.entries]) {
      const kept = bucket.filter((entry) => entry.metadata.loopId !== loopId)
      if (kept.length === 0) this.entries.delete(key)
      else if (kept.length !== bucket.length) this.entries.set(key, kept)
    }
  }

  clearAllForTests(): void {
    this.entries.clear()
  }

  private purgeExpired(): void {
    const now = this.now()
    for (const [key, bucket] of [...this.entries]) {
      const kept = bucket.filter((entry) => entry.expiresAt > now)
      if (kept.length === 0) this.entries.delete(key)
      else if (kept.length !== bucket.length) this.entries.set(key, kept)
    }
  }

  private enforceLoopBound(loopId: string): void {
    while (this.sizeForLoop(loopId) > this.maxEntriesPerLoop) {
      if (!this.evictOldest((entry) => entry.metadata.loopId === loopId)) return
    }
  }

  private enforceGlobalBound(): void {
    while (this.size > this.maxEntries) {
      if (!this.evictOldest(() => true)) return
    }
  }

  private evictOldest(predicate: (entry: CacheEntry) => boolean): boolean {
    for (const [key, bucket] of this.entries) {
      const index = bucket.findIndex(predicate)
      if (index < 0) continue
      bucket.splice(index, 1)
      if (bucket.length === 0) this.entries.delete(key)
      return true
    }
    return false
  }
}

export const reasoningCorrelationCache = new ReasoningCorrelationCache()
