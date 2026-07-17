import { describe, expect, test } from 'bun:test'
import { isKiroContextOverflowBody } from '../core/request/error-handler.js'

// isKiroContextOverflowBody decides whether a Kiro 400 body should be remapped
// to a 413 so OpenCode classifies it as context_overflow (→ ContextOverflowError
// → auto-compaction) instead of a bare terminal failure. It must match ONLY
// unambiguous size signals — the generic "Improperly formed request." has no
// size discriminator in the {message,__type} body we see, so matching it would
// wrongly reclassify unrelated malformed-request 400s.

describe('isKiroContextOverflowBody', () => {
  test('matches the observed Kiro overflow phrase (case-insensitive)', () => {
    expect(isKiroContextOverflowBody('Input is too long.')).toBe(true)
    expect(isKiroContextOverflowBody('input is too long')).toBe(true)
    expect(isKiroContextOverflowBody('Kiro Error: 400 - Input is too long.')).toBe(true)
  })

  test('matches the reason-code form CONTENT_LENGTH_EXCEEDS_THRESHOLD', () => {
    expect(isKiroContextOverflowBody('CONTENT_LENGTH_EXCEEDS_THRESHOLD')).toBe(true)
    expect(
      isKiroContextOverflowBody('{"message":"...","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}')
    ).toBe(true)
  })

  test('does NOT match the generic malformed-request phrase (no size discriminator)', () => {
    expect(isKiroContextOverflowBody('Improperly formed request.')).toBe(false)
  })

  test('does NOT match unrelated 400 reasons', () => {
    expect(
      isKiroContextOverflowBody('Invalid model. Please select a different model to continue.')
    ).toBe(false)
    expect(isKiroContextOverflowBody('')).toBe(false)
    expect(isKiroContextOverflowBody('Bad input')).toBe(false)
  })
})
