import { describe, expect, test } from 'bun:test'
import { UpstreamUnexpectedError } from '../core/request/stream-error.js'

// The heuristics pinned in the second describe live in opencode's
// src/session/retry.ts:127-150 (fallback retry classification for a plain Error
// that is neither ContextOverflowError nor APIError). If our terminal message
// ever matched one of them the host would silently replay a turn that already
// emitted output — duplicating text, tool calls, and quota.
const HOST_RETRY_TEXT_HEURISTICS = ['rate limit', 'too many requests', 'rate increased too quickly']

describe('UpstreamUnexpectedError.toResponse', () => {
  test('returns a 503 carrying Retry-After alongside Content-Type', () => {
    const response = new UpstreamUnexpectedError(new Error('boom'), false).toResponse()

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('retry-after')).toBe('2')
  })

  test('keeps the pre-output payload shape unchanged', async () => {
    const response = new UpstreamUnexpectedError(new Error('boom'), false).toResponse()

    expect(await response.json()).toEqual({
      retryable: true,
      phase: 'stream',
      emittedOutput: false,
      code: 'UPSTREAM_UNEXPECTED'
    })
  })

  test('reports emittedOutput from the constructed error', async () => {
    const response = new UpstreamUnexpectedError(new Error('boom'), true).toResponse()

    expect(await response.json()).toMatchObject({ emittedOutput: true })
  })
})

describe('UpstreamUnexpectedError message must not trip host retry heuristics', () => {
  test('is the exact terminal message', () => {
    expect(new UpstreamUnexpectedError(new Error('boom'), true).message).toBe(
      'Kiro upstream event stream failed unexpectedly'
    )
  })

  test('contains none of the host rate-limit text heuristics, case-insensitively', () => {
    const lowered = new UpstreamUnexpectedError(new Error('boom'), true).message.toLowerCase()

    for (const heuristic of HOST_RETRY_TEXT_HEURISTICS) {
      expect(lowered).not.toContain(heuristic)
    }
  })

  test('is not JSON the host would classify as retryable', () => {
    const message = new UpstreamUnexpectedError(new Error('boom'), true).message

    expect(matchesHostJsonRetryHeuristic(message)).toBe(false)
  })

  test('the JSON heuristic mirror does fire on the shapes the host retries', () => {
    expect(matchesHostJsonRetryHeuristic('{"code":"resource_exhausted"}')).toBe(true)
    expect(matchesHostJsonRetryHeuristic('{"code":"service_unavailable"}')).toBe(true)
    expect(
      matchesHostJsonRetryHeuristic('{"type":"error","error":{"type":"too_many_requests"}}')
    ).toBe(true)
  })
})

function matchesHostJsonRetryHeuristic(message: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    return false
  }

  if (typeof parsed !== 'object' || parsed === null) return false

  const record = parsed as { code?: unknown; type?: unknown }
  const code = typeof record.code === 'string' ? record.code : ''
  return code.includes('exhausted') || code.includes('unavailable') || record.type === 'error'
}
