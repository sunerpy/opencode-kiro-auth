import { describe, expect, test } from 'bun:test'
import { RetryStrategy } from '../core/request/retry-strategy.js'

// RetryStrategy is a pure iteration/timeout gate. No mocking needed: we drive
// real RetryContext objects and assert the returned decision + error string.

describe('RetryStrategy.createContext', () => {
  test('starts at iteration 0', () => {
    const strat = new RetryStrategy({ max_request_iterations: 5 })
    const ctx = strat.createContext()
    expect(ctx).toEqual({ iterations: 0 })
  })
})

describe('RetryStrategy.shouldContinue - iteration cap', () => {
  test('increments the context iteration on each call', () => {
    const strat = new RetryStrategy({ max_request_iterations: 3 })
    const ctx = strat.createContext()
    strat.shouldContinue(ctx)
    expect(ctx.iterations).toBe(1)
    strat.shouldContinue(ctx)
    expect(ctx.iterations).toBe(2)
  })

  test('allows exactly max_request_iterations calls, then stops on the next', () => {
    const strat = new RetryStrategy({ max_request_iterations: 3 })
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

describe('RetryStrategy.shouldContinue - wall clock independence', () => {
  test('does not apply the stream inactivity timeout as a total retry wall clock', () => {
    const strat = new RetryStrategy({ max_request_iterations: 100 })
    const ctx = { iterations: 0 }
    const result = strat.shouldContinue(ctx)
    expect(result.canContinue).toBe(true)
    expect(result.error).toBeUndefined()
  })
})
