import { describe, expect, test } from 'bun:test'
import { RetryStrategy } from '../core/request/retry-strategy.js'

// RetryStrategy is a pure iteration/timeout gate. No mocking needed: we drive
// real RetryContext objects and assert the returned decision + error string.

describe('RetryStrategy.createContext', () => {
  test('starts at iteration 0 with a startTime near now', () => {
    const strat = new RetryStrategy({ max_request_iterations: 5, request_timeout_ms: 60000 })
    const before = Date.now()
    const ctx = strat.createContext()
    expect(ctx.iterations).toBe(0)
    expect(ctx.startTime).toBeGreaterThanOrEqual(before)
    expect(ctx.startTime).toBeLessThanOrEqual(Date.now())
  })
})

describe('RetryStrategy.shouldContinue - iteration cap', () => {
  test('increments the context iteration on each call', () => {
    const strat = new RetryStrategy({ max_request_iterations: 3, request_timeout_ms: 60000 })
    const ctx = strat.createContext()
    strat.shouldContinue(ctx)
    expect(ctx.iterations).toBe(1)
    strat.shouldContinue(ctx)
    expect(ctx.iterations).toBe(2)
  })

  test('allows exactly max_request_iterations calls, then stops on the next', () => {
    const strat = new RetryStrategy({ max_request_iterations: 3, request_timeout_ms: 60000 })
    const ctx = strat.createContext()
    // iterations go 1,2,3 -> all <= 3 -> canContinue
    expect(strat.shouldContinue(ctx).canContinue).toBe(true)
    expect(strat.shouldContinue(ctx).canContinue).toBe(true)
    expect(strat.shouldContinue(ctx).canContinue).toBe(true)
    // 4th call: iterations becomes 4 > 3 -> stop with the cap error.
    const stop = strat.shouldContinue(ctx)
    expect(stop.canContinue).toBe(false)
    expect(stop.error).toBe('Exceeded max iterations (3)')
  })
})

describe('RetryStrategy.shouldContinue - timeout', () => {
  test('stops with a timeout error when startTime is older than request_timeout_ms', () => {
    const strat = new RetryStrategy({ max_request_iterations: 100, request_timeout_ms: 1000 })
    // Hand-craft a context whose startTime is well in the past.
    const ctx = { iterations: 0, startTime: Date.now() - 5000 }
    const result = strat.shouldContinue(ctx)
    expect(result.canContinue).toBe(false)
    expect(result.error).toBe('Request timeout')
  })

  test('iteration cap is checked before timeout when both would trip', () => {
    const strat = new RetryStrategy({ max_request_iterations: 1, request_timeout_ms: 1 })
    const ctx = { iterations: 5, startTime: Date.now() - 5000 }
    const result = strat.shouldContinue(ctx)
    expect(result.canContinue).toBe(false)
    // iterations 6 > 1 fires first.
    expect(result.error).toBe('Exceeded max iterations (1)')
  })

  test('continues when within both the iteration cap and the timeout', () => {
    const strat = new RetryStrategy({ max_request_iterations: 10, request_timeout_ms: 60000 })
    const ctx = strat.createContext()
    const result = strat.shouldContinue(ctx)
    expect(result.canContinue).toBe(true)
    expect(result.error).toBeUndefined()
  })
})
