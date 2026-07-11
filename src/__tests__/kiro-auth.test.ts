import { describe, expect, test } from 'bun:test'
import { accessTokenExpired, decodeRefreshToken, encodeRefreshToken } from '../kiro/auth.js'
import type { KiroAuthDetails } from '../plugin/types.js'

describe('decodeRefreshToken', () => {
  test('single-part token (no pipe) => desktop with whole string as refreshToken', () => {
    expect(decodeRefreshToken('plain-refresh-token')).toEqual({
      refreshToken: 'plain-refresh-token',
      authMethod: 'desktop'
    })
  })

  test('idc token encodes clientId/clientSecret in order', () => {
    expect(decodeRefreshToken('rtoken|my-client-id|my-client-secret|idc')).toEqual({
      refreshToken: 'rtoken',
      clientId: 'my-client-id',
      clientSecret: 'my-client-secret',
      authMethod: 'idc'
    })
  })

  test('explicit desktop suffix => desktop, credentials dropped', () => {
    expect(decodeRefreshToken('rtoken|desktop')).toEqual({
      refreshToken: 'rtoken',
      authMethod: 'desktop'
    })
  })

  test('unrecognized trailing method falls back to desktop', () => {
    expect(decodeRefreshToken('rtoken|extra|social')).toEqual({
      refreshToken: 'rtoken',
      authMethod: 'desktop'
    })
  })

  test('empty string => desktop with empty refreshToken', () => {
    expect(decodeRefreshToken('')).toEqual({
      refreshToken: '',
      authMethod: 'desktop'
    })
  })
})

describe('accessTokenExpired', () => {
  const base = (): KiroAuthDetails => ({
    refresh: 'r',
    access: 'a',
    expires: 0,
    authMethod: 'desktop',
    region: 'us-east-1'
  })

  test('returns true when access token is missing', () => {
    expect(accessTokenExpired({ ...base(), access: '', expires: Date.now() + 999999 })).toBe(true)
  })

  test('returns true when expires is missing (falsy)', () => {
    expect(accessTokenExpired({ ...base(), access: 'a', expires: 0 })).toBe(true)
  })

  test('returns false when far in the future beyond buffer', () => {
    expect(accessTokenExpired({ ...base(), expires: Date.now() + 3_600_000 }, 120000)).toBe(false)
  })

  test('returns true when already past expiry', () => {
    expect(accessTokenExpired({ ...base(), expires: Date.now() - 1000 }, 120000)).toBe(true)
  })

  test('returns true inside the expiry buffer window', () => {
    // expires 60s out, buffer 120s => Date.now() >= expires - 120000 is true
    expect(accessTokenExpired({ ...base(), expires: Date.now() + 60_000 }, 120000)).toBe(true)
  })

  test('boundary: expires exactly one buffer ahead is treated as expired (>=)', () => {
    const now = Date.now()
    // expires - buffer == now  =>  now >= now  => true
    expect(accessTokenExpired({ ...base(), expires: now + 120000 }, 120000)).toBe(true)
  })

  test('just past the buffer boundary is not expired', () => {
    expect(accessTokenExpired({ ...base(), expires: Date.now() + 130_000 }, 120000)).toBe(false)
  })

  test('zero buffer: not expired when a bit in the future', () => {
    expect(accessTokenExpired({ ...base(), expires: Date.now() + 5000 }, 0)).toBe(false)
  })
})

describe('encodeRefreshToken', () => {
  test('desktop always appends |desktop regardless of credentials', () => {
    expect(encodeRefreshToken({ refreshToken: 'rt', authMethod: 'desktop' })).toBe('rt|desktop')
  })

  test('idc encodes refreshToken|clientId|clientSecret|idc', () => {
    expect(
      encodeRefreshToken({
        refreshToken: 'rt',
        clientId: 'cid',
        clientSecret: 'csec',
        authMethod: 'idc'
      })
    ).toBe('rt|cid|csec|idc')
  })

  test('idc without clientId throws', () => {
    expect(() =>
      encodeRefreshToken({ refreshToken: 'rt', clientSecret: 'csec', authMethod: 'idc' })
    ).toThrow('Missing credentials')
  })

  test('idc without clientSecret throws', () => {
    expect(() =>
      encodeRefreshToken({ refreshToken: 'rt', clientId: 'cid', authMethod: 'idc' })
    ).toThrow('Missing credentials')
  })

  test('round-trip: decode(encode(idc)) preserves parts', () => {
    const encoded = encodeRefreshToken({
      refreshToken: 'rt',
      clientId: 'cid',
      clientSecret: 'csec',
      authMethod: 'idc'
    })
    expect(decodeRefreshToken(encoded)).toEqual({
      refreshToken: 'rt',
      clientId: 'cid',
      clientSecret: 'csec',
      authMethod: 'idc'
    })
  })

  test('round-trip: decode(encode(desktop)) preserves refreshToken and method', () => {
    const encoded = encodeRefreshToken({ refreshToken: 'rt', authMethod: 'desktop' })
    expect(decodeRefreshToken(encoded)).toEqual({
      refreshToken: 'rt',
      authMethod: 'desktop'
    })
  })
})
