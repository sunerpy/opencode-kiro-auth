import { describe, expect, test } from 'bun:test'
import { decideRecoveryTier } from '../core/request/stream-recovery.js'
import {
  TestStreamFailure,
  chunk,
  collect,
  createHarness,
  makeAttempt
} from './stream-recovery.fixture.js'

const VISIBLE_OBSERVATION = {
  emitted: { visibleChars: 11, toolCount: 0 },
  sawToolIntent: false
} as const

function toolCall(index: number, id: string, name: string, argumentsJson: string): unknown {
  return { index, id, function: { name, arguments: argumentsJson } }
}

describe('exact replay recovery tier', () => {
  test('downgrades to reasoning_restart when Tier A remains eligible', () => {
    // Given
    const input = {
      mode: 'exact_replay',
      emitted: { visibleChars: 0, toolCount: 0 },
      sawToolIntent: false
    } as const

    // When / Then
    expect(decideRecoveryTier(input)).toBe('reasoning_restart')
  })

  test('selects exact_replay only after visible or tool output was delivered', () => {
    // Given
    const visible = {
      mode: 'exact_replay',
      emitted: { visibleChars: 1, toolCount: 0 },
      sawToolIntent: false
    } as const
    const tool = {
      mode: 'exact_replay',
      emitted: { visibleChars: 0, toolCount: 1 },
      sawToolIntent: true
    } as const
    const intentOnly = {
      mode: 'exact_replay',
      emitted: { visibleChars: 0, toolCount: 0 },
      sawToolIntent: true
    } as const

    // When / Then
    expect([visible, tool, intentOnly].map(decideRecoveryTier)).toEqual([
      'exact_replay',
      'exact_replay',
      'none'
    ])
  })
})

describe('StreamRecoveryCoordinator exact replay', () => {
  test('matches different text chunk splits and releases only the new suffix plus one terminal', async () => {
    // Given
    const first = makeAttempt({
      output: [chunk('first-1', { content: 'hello ' }), chunk('first-2', { content: 'world' })],
      observation: VISIBLE_OBSERVATION,
      failure: new TestStreamFailure('failed after visible prefix')
    })
    const replay = makeAttempt({
      output: [
        chunk('shadow-1', { content: 'hel' }),
        chunk('suffix', { content: 'lo world!' }),
        chunk('finish', {}, 'stop')
      ]
    })
    const harness = createHarness([first, replay], { mode: 'exact_replay' })

    // When
    const labels = await collect(harness.coordinator.stream)

    // Then
    expect(labels).toEqual(['first-1', 'first-2', 'suffix', 'finish'])
    expect(harness.requestedAttempts).toEqual([1, 2])
    expect(harness.completions).toEqual([
      { attemptIndex: 2, recoveryTier: 'exact_replay', recovered: false }
    ])
    expect(harness.replayTelemetry).toEqual([
      {
        matchedReasoningChars: 0,
        matchedVisibleChars: 11,
        matchedToolCount: 0,
        divergenceChannel: 'none',
        replayOutcome: 'caught_up',
        attempts: 2
      }
    ])
    expect(harness.terminalCalls()).toBe(1)
  })

  test('consumes a text-divergent replay budget slot without leaking its chunk', async () => {
    // Given
    const first = makeAttempt({
      output: [chunk('first', { content: 'hello world' })],
      observation: VISIBLE_OBSERVATION,
      failure: new TestStreamFailure('first failure')
    })
    const divergent = makeAttempt({ output: [chunk('must-not-leak', { content: 'hello wurld' })] })
    const recovered = makeAttempt({
      output: [chunk('suffix', { content: 'hello world!' }), chunk('finish', {}, 'stop')]
    })
    const harness = createHarness([first, divergent, recovered], { mode: 'exact_replay' })

    // When
    const labels = await collect(harness.coordinator.stream)

    // Then
    expect(labels).toEqual(['first', 'suffix', 'finish'])
    expect(harness.requestedAttempts).toEqual([1, 2, 3])
    expect(
      harness.replayTelemetry.map(({ replayOutcome, divergenceChannel }) => ({
        replayOutcome,
        divergenceChannel
      }))
    ).toEqual([
      { replayOutcome: 'diverged', divergenceChannel: 'text' },
      { replayOutcome: 'caught_up', divergenceChannel: 'none' }
    ])
  })

  test('consumes a reasoning-divergent replay budget slot without leaking its chunk', async () => {
    // Given
    const first = makeAttempt({
      output: [
        chunk('first-reasoning', { reasoning_content: 'think' }),
        chunk('first-text', { content: 'answer' })
      ],
      observation: { emitted: { visibleChars: 6, toolCount: 0 }, sawToolIntent: false },
      failure: new TestStreamFailure('first failure')
    })
    const divergent = makeAttempt({
      output: [chunk('must-not-leak', { reasoning_content: 'thunk', content: 'answer' })]
    })
    const recovered = makeAttempt({
      output: [
        chunk('matched-reasoning', { reasoning_content: 'think' }),
        chunk('suffix', { content: 'answer!' }),
        chunk('finish', {}, 'stop')
      ]
    })
    const harness = createHarness([first, divergent, recovered], { mode: 'exact_replay' })

    // When
    const labels = await collect(harness.coordinator.stream)

    // Then
    expect(labels).toEqual(['first-reasoning', 'first-text', 'suffix', 'finish'])
    expect(harness.requestedAttempts).toEqual([1, 2, 3])
    expect(harness.replayTelemetry[0]).toEqual({
      matchedReasoningChars: 2,
      matchedVisibleChars: 0,
      matchedToolCount: 0,
      divergenceChannel: 'reasoning',
      replayOutcome: 'diverged',
      attempts: 2
    })
  })

  test('rejects reordered tools and catches up on a later replay without duplicating tools', async () => {
    // Given
    const firstCalls = [
      toolCall(0, 'tool-1', 'read', '{"path":"/a"}'),
      toolCall(1, 'tool-2', 'write', '{"path":"/b"}')
    ]
    const first = makeAttempt({
      output: [chunk('first-tools', { tool_calls: firstCalls })],
      observation: { emitted: { visibleChars: 0, toolCount: 2 }, sawToolIntent: true },
      failure: new TestStreamFailure('failed after tools')
    })
    const reordered = makeAttempt({
      output: [chunk('must-not-leak', { tool_calls: [firstCalls[1], firstCalls[0]] })]
    })
    const recovered = makeAttempt({
      output: [
        chunk('matched-tools', { tool_calls: firstCalls }),
        chunk('finish', {}, 'tool_calls')
      ]
    })
    const harness = createHarness([first, reordered, recovered], { mode: 'exact_replay' })

    // When
    const labels = await collect(harness.coordinator.stream)

    // Then
    expect(labels).toEqual(['first-tools', 'finish'])
    expect(harness.requestedAttempts).toEqual([1, 2, 3])
    expect(harness.replayTelemetry[0]?.divergenceChannel).toBe('tool')
  })

  test('treats an early replay terminal as divergence and spends another attempt', async () => {
    // Given
    const first = makeAttempt({
      output: [chunk('first', { content: 'hello world' })],
      observation: VISIBLE_OBSERVATION,
      failure: new TestStreamFailure('first failure')
    })
    const early = makeAttempt({
      output: [chunk('shadow', { content: 'hello' }), chunk('must-not-leak', {}, 'stop')]
    })
    const recovered = makeAttempt({
      output: [chunk('suffix', { content: 'hello world!' }), chunk('finish', {}, 'stop')]
    })
    const harness = createHarness([first, early, recovered], { mode: 'exact_replay' })

    // When
    const labels = await collect(harness.coordinator.stream)

    // Then
    expect(labels).toEqual(['first', 'suffix', 'finish'])
    expect(harness.requestedAttempts).toEqual([1, 2, 3])
    expect(harness.replayTelemetry[0]?.divergenceChannel).toBe('early_end')
  })

  test('reports a replay stream failure before catch-up without leaking its shadow bytes', async () => {
    // Given
    const first = makeAttempt({
      output: [chunk('first', { content: 'hello world' })],
      observation: VISIBLE_OBSERVATION,
      failure: new TestStreamFailure('first failure')
    })
    const failed = makeAttempt({
      output: [chunk('must-not-leak', { content: 'hello' })],
      failure: new TestStreamFailure('replay transport failure')
    })
    const recovered = makeAttempt({
      output: [chunk('suffix', { content: 'hello world!' }), chunk('finish', {}, 'stop')]
    })
    const harness = createHarness([first, failed, recovered], { mode: 'exact_replay' })

    // When
    const labels = await collect(harness.coordinator.stream)

    // Then
    expect(labels).toEqual(['first', 'suffix', 'finish'])
    expect(harness.replayTelemetry[0]).toEqual({
      matchedReasoningChars: 0,
      matchedVisibleChars: 5,
      matchedToolCount: 0,
      divergenceChannel: 'none',
      replayOutcome: 'failed',
      attempts: 2
    })
  })
})
