import { describe, expect, test } from 'bun:test'
import { decideRecoveryTier, type AttemptHandle } from '../core/request/stream-recovery.js'
import {
  ELIGIBLE,
  EMPTY_OBSERVATION,
  TestStreamFailure,
  chunk,
  collect,
  createHarness,
  expectRejection,
  makeAttempt,
  reasoningFailure
} from './stream-recovery.fixture.js'

describe('decideRecoveryTier', () => {
  test('returns reasoning_restart when recovery is enabled and no visible or tool output exists', () => {
    // Given
    const input = ELIGIBLE
    // When / Then
    expect(decideRecoveryTier(input)).toBe('reasoning_restart')
  })

  test('returns none for disabled mode, visible output, emitted tools, or raw tool intent', () => {
    // Given
    const unsafe = [
      { ...ELIGIBLE, mode: 'off' },
      { ...ELIGIBLE, emitted: { visibleChars: 1, toolCount: 0 } },
      { ...ELIGIBLE, emitted: { visibleChars: 0, toolCount: 1 } },
      { ...ELIGIBLE, sawToolIntent: true }
    ] as const
    // When
    const tiers = unsafe.map(decideRecoveryTier)
    // Then
    expect(tiers).toEqual(['none', 'none', 'none', 'none'])
  })
})

describe('StreamRecoveryCoordinator', () => {
  test('continues reasoning in one stream and publishes only the successful terminal sequence', async () => {
    // Given
    const first = makeAttempt({
      output: [
        chunk('reasoning-1', { reasoning_content: 'first' }),
        chunk('failed-finish', {}, 'stop'),
        chunk('failed-after-finish')
      ],
      failure: new TestStreamFailure('first attempt failed')
    })
    const second = makeAttempt({
      output: [chunk('reasoning-2', { reasoning_content: 'second' }), chunk('finish', {}, 'stop')]
    })
    const harness = createHarness([first, second])
    // When
    const labels = await collect(harness.coordinator.stream)
    // Then
    expect(labels).toEqual(['reasoning-1', 'reasoning-2', 'finish'])
    expect(harness.requestedAttempts).toEqual([1, 2])
    expect(harness.completions).toEqual([
      { attemptIndex: 2, recoveryTier: 'reasoning_restart', recovered: true }
    ])
    expect(harness.terminalCalls()).toBe(1)
  })

  test('terminates with the mapped error after visible text and requests no recovery', async () => {
    // Given
    const mapped = new TestStreamFailure('visible output cannot restart')
    const attempt = makeAttempt({
      output: [chunk('visible', { content: 'answer' })],
      observation: { emitted: { visibleChars: 6, toolCount: 0 }, sawToolIntent: false },
      failure: new TestStreamFailure('failed after text')
    })
    const harness = createHarness([attempt], { maxAttempts: 3, mapError: () => mapped })
    const reader = harness.coordinator.stream.getReader()
    // When / Then
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('visible')
    await expectRejection(reader.read(), mapped)
    expect(harness.requestedAttempts).toEqual([1])
    expect(harness.terminalCalls()).toBe(1)
  })

  test('raw tool intent makes a reasoning-only failure ineligible', async () => {
    // Given
    const mapped = new TestStreamFailure('tool intent cannot restart')
    const attempt = makeAttempt({
      output: [chunk('reasoning', { reasoning_content: 'thinking' })],
      observation: { emitted: { visibleChars: 0, toolCount: 0 }, sawToolIntent: true },
      failure: new TestStreamFailure('failed after tool intent')
    })
    const harness = createHarness([attempt], { maxAttempts: 3, mapError: () => mapped })
    const reader = harness.coordinator.stream.getReader()
    // When / Then
    await reader.read()
    await expectRejection(reader.read(), mapped)
    expect(harness.requestedAttempts).toEqual([1])
  })

  test('maps only the last failure when the total attempt budget is exhausted', async () => {
    // Given
    const failures = [new TestStreamFailure('one'), new TestStreamFailure('two')]
    const mapped = new TestStreamFailure('last failure', { cause: failures[1] })
    const harness = createHarness(
      failures.map((failure, index) =>
        makeAttempt({
          output: [chunk(`reasoning-${index + 1}`, { reasoning_content: 'x' })],
          failure
        })
      ),
      { maxAttempts: 2, mapError: (failure) => (failure === failures[1] ? mapped : new Error()) }
    )
    const reader = harness.coordinator.stream.getReader()
    // When / Then
    await reader.read()
    await reader.read()
    await expectRejection(reader.read(), mapped)
    expect(harness.requestedAttempts).toEqual([1, 2])
    expect(harness.terminalCalls()).toBe(1)
  })

  test('abort during backoff errors immediately and prevents another factory call', async () => {
    // Given
    const controller = new AbortController()
    const backoffStarted = Promise.withResolvers<void>()
    const harness = createHarness([reasoningFailure('one')], {
      maxAttempts: 3,
      signal: controller.signal,
      delayFn: (_attemptIndex, signal) =>
        new Promise<void>((_resolve, reject) => {
          backoffStarted.resolve()
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    })
    const reader = harness.coordinator.stream.getReader()
    await reader.read()
    const pendingRead = reader.read()
    await backoffStarted.promise
    // When
    const reason = new DOMException('cancelled in backoff', 'AbortError')
    controller.abort(reason)
    // Then
    await expectRejection(pendingRead, reason)
    expect(harness.requestedAttempts).toEqual([1])
    expect(harness.terminalCalls()).toBe(1)
  })

  test('abort during an upstream pull errors immediately and closes the active attempt', async () => {
    // Given
    const controller = new AbortController()
    const pullStarted = Promise.withResolvers<void>()
    let closeCalls = 0
    const attempt: AttemptHandle = {
      chunks: {
        next: () => {
          pullStarted.resolve()
          return new Promise<IteratorResult<unknown>>(() => {})
        }
      },
      observed: () => EMPTY_OBSERVATION,
      close: async () => {
        closeCalls++
      }
    }
    const harness = createHarness([attempt], { maxAttempts: 3, signal: controller.signal })
    const pendingRead = harness.coordinator.stream.getReader().read()
    await pullStarted.promise
    // When
    const reason = new DOMException('cancelled in pull', 'AbortError')
    controller.abort(reason)
    // Then
    await expectRejection(pendingRead, reason)
    await Promise.resolve()
    expect(closeCalls).toBe(1)
    expect(harness.requestedAttempts).toEqual([1])
    expect(harness.terminalCalls()).toBe(1)
  })

  test('mode off maps the first failure without a recovery attempt', async () => {
    // Given
    const mapped = new TestStreamFailure('recovery disabled')
    const attempt = makeAttempt({ output: [], failure: new TestStreamFailure('off') })
    const harness = createHarness([attempt], {
      mode: 'off',
      maxAttempts: 3,
      mapError: () => mapped
    })
    // When / Then
    await expectRejection(collect(harness.coordinator.stream), mapped)
    expect(harness.requestedAttempts).toEqual([1])
  })

  test('an empty recovery attempt completes the same stream cleanly', async () => {
    // Given
    const first = reasoningFailure('retry')
    const harness = createHarness([first, makeAttempt({ output: [] })])
    // When
    const labels = await collect(harness.coordinator.stream)
    // Then
    expect(labels).toEqual(['reasoning'])
    expect(harness.completions).toEqual([
      { attemptIndex: 2, recoveryTier: 'reasoning_restart', recovered: true }
    ])
    expect(harness.terminalCalls()).toBe(1)
  })

  test('cumulative visible output on the second failure prevents a third attempt', async () => {
    // Given
    const lastFailure = new TestStreamFailure('failed after recovered text')
    const mapped = new TestStreamFailure('cumulative output blocks retry', { cause: lastFailure })
    const first = reasoningFailure('first')
    const second = makeAttempt({
      output: [chunk('visible', { content: 'answer' })],
      observation: { emitted: { visibleChars: 6, toolCount: 0 }, sawToolIntent: false },
      failure: lastFailure
    })
    const harness = createHarness([first, second], { maxAttempts: 3, mapError: () => mapped })
    const reader = harness.coordinator.stream.getReader()
    // When / Then
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('reasoning')
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('visible')
    await expectRejection(reader.read(), mapped)
    expect(harness.requestedAttempts).toEqual([1, 2])
    expect(harness.terminalCalls()).toBe(1)
  })
})
