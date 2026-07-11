import { describe, expect, test } from 'bun:test'
import {
  KiroAuthError,
  KiroQuotaExhaustedError,
  KiroRateLimitError,
  KiroTokenRefreshError
} from '../plugin/errors.js'

describe('KiroTokenRefreshError', () => {
  test('sets name, message, code and originalError', () => {
    const original = new Error('boom')
    const err = new KiroTokenRefreshError('refresh failed', 'HTTP_401', original)
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(KiroTokenRefreshError)
    expect(err.name).toBe('KiroTokenRefreshError')
    expect(err.message).toBe('refresh failed')
    expect(err.code).toBe('HTTP_401')
    expect(err.originalError).toBe(original)
  })

  test('code and originalError are undefined when omitted', () => {
    const err = new KiroTokenRefreshError('refresh failed')
    expect(err.name).toBe('KiroTokenRefreshError')
    expect(err.message).toBe('refresh failed')
    expect(err.code).toBeUndefined()
    expect(err.originalError).toBeUndefined()
  })
})

describe('KiroQuotaExhaustedError', () => {
  test('sets name, message and recoveryTime', () => {
    const err = new KiroQuotaExhaustedError('quota gone', 1700000000000)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('KiroQuotaExhaustedError')
    expect(err.message).toBe('quota gone')
    expect(err.recoveryTime).toBe(1700000000000)
  })

  test('recoveryTime undefined when omitted', () => {
    const err = new KiroQuotaExhaustedError('quota gone')
    expect(err.recoveryTime).toBeUndefined()
  })
})

describe('KiroRateLimitError', () => {
  test('sets name, message and retryAfter', () => {
    const err = new KiroRateLimitError('slow down', 30)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('KiroRateLimitError')
    expect(err.message).toBe('slow down')
    expect(err.retryAfter).toBe(30)
  })

  test('retryAfter undefined when omitted', () => {
    const err = new KiroRateLimitError('slow down')
    expect(err.retryAfter).toBeUndefined()
  })
})

describe('KiroAuthError', () => {
  test('sets name, message and statusCode', () => {
    const err = new KiroAuthError('forbidden', 403)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('KiroAuthError')
    expect(err.message).toBe('forbidden')
    expect(err.statusCode).toBe(403)
  })

  test('statusCode undefined when omitted', () => {
    const err = new KiroAuthError('forbidden')
    expect(err.statusCode).toBeUndefined()
  })
})

describe('error classes are distinct types', () => {
  test('a KiroAuthError is not a KiroRateLimitError', () => {
    const err = new KiroAuthError('x', 403)
    expect(err instanceof KiroRateLimitError).toBe(false)
    expect(err instanceof KiroAuthError).toBe(true)
  })

  test('errors carry a stack trace', () => {
    const err = new KiroTokenRefreshError('x')
    expect(typeof err.stack).toBe('string')
  })
})
