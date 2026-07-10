import { describe, expect, test } from 'bun:test'
import { resolveEffort, supportsEffort, supportsXHighEffort } from '../plugin/effort.js'
import { resolveModelVariant } from '../plugin/models.js'
import { transformToSdkRequest } from '../plugin/request.js'
import type { KiroAuthDetails } from '../plugin/types'

// Minimal fake auth — pure unit, no network. transformToSdkRequest only reads
// auth.region and auth.profileArn for region resolution and auth.access is
// never dereferenced in the transform path.
const fakeAuth: KiroAuthDetails = {
  refresh: 'fake-refresh',
  access: 'fake-access',
  expires: Date.now() + 3_600_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

const minimalBody = { messages: [{ role: 'user', content: 'hi' }] }

describe('resolveModelVariant', () => {
  describe('parse — variants (exact deep-equal)', () => {
    test('claude-opus-4-8-xhigh -> {wireId: claude-opus-4.8, effort: xhigh}', () => {
      expect(resolveModelVariant('claude-opus-4-8-xhigh')).toEqual({
        wireId: 'claude-opus-4.8',
        effort: 'xhigh'
      })
    })

    test('claude-sonnet-4-6-max -> {wireId: claude-sonnet-4.6, effort: max}', () => {
      expect(resolveModelVariant('claude-sonnet-4-6-max')).toEqual({
        wireId: 'claude-sonnet-4.6',
        effort: 'max'
      })
    })

    test('claude-sonnet-5-high -> {wireId: claude-sonnet-5, effort: high}', () => {
      expect(resolveModelVariant('claude-sonnet-5-high')).toEqual({
        wireId: 'claude-sonnet-5',
        effort: 'high'
      })
    })

    test('claude-opus-4-7-low and -medium parse to the 4.7 wire id', () => {
      expect(resolveModelVariant('claude-opus-4-7-low')).toEqual({
        wireId: 'claude-opus-4.7',
        effort: 'low'
      })
      expect(resolveModelVariant('claude-opus-4-7-medium')).toEqual({
        wireId: 'claude-opus-4.7',
        effort: 'medium'
      })
    })
  })

  describe('parse — NON-variants (no misparse, effort stays undefined)', () => {
    test('plain base claude-opus-4-8 is NOT a variant', () => {
      const r = resolveModelVariant('claude-opus-4-8')
      expect(r.wireId).toBe('claude-opus-4.8')
      expect(r.effort).toBeUndefined()
    })

    test('claude-opus-4-8-thinking gets wire id from map, no effort', () => {
      const r = resolveModelVariant('claude-opus-4-8-thinking')
      expect(r.wireId).toBe('claude-opus-4.8')
      expect(r.effort).toBeUndefined()
    })

    test('claude-sonnet-4-5-1m is a mapped slug, not an effort variant', () => {
      const r = resolveModelVariant('claude-sonnet-4-5-1m')
      expect(r.wireId).toBe('claude-sonnet-4.5-1m')
      expect(r.effort).toBeUndefined()
    })

    test('claude-haiku-4-5-high: base not in allowlist -> NOT a variant (throws, no misparse)', () => {
      // haiku base is not allowlisted, so this falls through to resolveKiroModel
      // on the full unmapped slug and throws — a misparse would have returned an
      // effort instead of throwing.
      expect(() => resolveModelVariant('claude-haiku-4-5-high')).toThrow('Unsupported model')
    })

    test('non-effort suffix on an allowlisted base is not a variant', () => {
      // `-thinking` is not an effort suffix, so claude-sonnet-5-thinking stays a
      // plain mapped slug.
      const r = resolveModelVariant('claude-sonnet-5-thinking')
      expect(r.wireId).toBe('claude-sonnet-5')
      expect(r.effort).toBeUndefined()
    })
  })
})

describe('effort capability', () => {
  test('claude-sonnet-5 supports effort and xhigh', () => {
    expect(supportsEffort('claude-sonnet-5')).toBe(true)
    expect(supportsXHighEffort('claude-sonnet-5')).toBe(true)
    expect(resolveEffort('claude-sonnet-5', 'xhigh')).toBe('xhigh')
  })

  test('claude-sonnet-4.6 supports effort but NOT xhigh (clamped to max)', () => {
    expect(supportsEffort('claude-sonnet-4.6')).toBe(true)
    expect(supportsXHighEffort('claude-sonnet-4.6')).toBe(false)
    expect(resolveEffort('claude-sonnet-4.6', 'xhigh')).toBe('max')
  })

  test('opus 4.7 and 4.8 keep xhigh (no clamp)', () => {
    expect(resolveEffort('claude-opus-4.7', 'xhigh')).toBe('xhigh')
    expect(resolveEffort('claude-opus-4.8', 'xhigh')).toBe('xhigh')
  })
})

describe('transformToSdkRequest — end-to-end effort selection', () => {
  test('variant claude-opus-4-8-xhigh -> effort xhigh, wire id claude-opus-4.8', () => {
    const req = transformToSdkRequest(minimalBody, 'claude-opus-4-8-xhigh', fakeAuth)
    expect(req.effort).toBe('xhigh')
    expect(req.effectiveModel).toBe('claude-opus-4.8')
    expect(req.conversationState.currentMessage.userInputMessage?.modelId).toBe('claude-opus-4.8')
  })

  test('variant claude-sonnet-4-6-max -> effort max, wire id claude-sonnet-4.6', () => {
    const req = transformToSdkRequest(minimalBody, 'claude-sonnet-4-6-max', fakeAuth)
    expect(req.effort).toBe('max')
    expect(req.effectiveModel).toBe('claude-sonnet-4.6')
    expect(req.conversationState.currentMessage.userInputMessage?.modelId).toBe('claude-sonnet-4.6')
  })

  test('variant on non-xhigh base clamps xhigh -> max (claude-sonnet-4-6-xhigh)', () => {
    const req = transformToSdkRequest(minimalBody, 'claude-sonnet-4-6-xhigh', fakeAuth)
    expect(req.effort).toBe('max')
    expect(req.effectiveModel).toBe('claude-sonnet-4.6')
  })

  test('variant precedence: parsed variant effort overrides global config effort', () => {
    const req = transformToSdkRequest(
      minimalBody,
      'claude-opus-4-8-low',
      fakeAuth,
      false,
      20000,
      undefined,
      {
        effort: 'max'
      }
    )
    expect(req.effort).toBe('low')
    expect(req.effectiveModel).toBe('claude-opus-4.8')
  })

  test('non-variant claude-opus-4-8 without think/config -> effort undefined', () => {
    const req = transformToSdkRequest(minimalBody, 'claude-opus-4-8', fakeAuth)
    expect(req.effort).toBeUndefined()
    expect(req.effectiveModel).toBe('claude-opus-4.8')
  })

  test('non-variant follows existing behavior: config effort applies when no variant', () => {
    const req = transformToSdkRequest(
      minimalBody,
      'claude-opus-4-8',
      fakeAuth,
      false,
      20000,
      undefined,
      {
        effort: 'high'
      }
    )
    expect(req.effort).toBe('high')
    expect(req.effectiveModel).toBe('claude-opus-4.8')
  })
})
