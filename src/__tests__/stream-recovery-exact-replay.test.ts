import { describe, expect, test } from 'bun:test'
import { decideRecoveryTier, type AttemptHandle } from '../core/request/stream-recovery.js'
import {
  EMPTY_OBSERVATION,
  TestStreamFailure,
  chunk,
  collect,
  createHarness,
  expectRejection,
  makeAttempt
} from './stream-recovery.fixture.js'

const VISIBLE_OBSERVATION = {
  emitted: { visibleChars: 11, toolCount: 0 },
  sawToolIntent: false
} as const

const COMMITMENT_TEXT = '我现在派两个并行任务。'
const COMMITMENT_OBSERVATION = {
  emitted: { visibleChars: COMMITMENT_TEXT.length, toolCount: 0 },
  sawToolIntent: false,
  terminalSource: 'clean_eof_without_completion_metadata',
  availableToolCount: 94,
  forwardActionCommitment: 'zh_immediate_first_person'
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
  test('retries one clean EOF action commitment and releases only the replay suffix', async () => {
    // Given
    const first = makeAttempt({
      output: [
        chunk('commitment', { content: COMMITMENT_TEXT }),
        chunk('discarded-finish', {}, 'stop')
      ],
      observation: COMMITMENT_OBSERVATION
    })
    const replay = makeAttempt({
      output: [
        chunk('shadow', { content: COMMITMENT_TEXT }),
        chunk('task', {
          tool_calls: [toolCall(0, 'tool-1', 'task', '{"description":"fix titlebar"}')]
        }),
        chunk('finish', {}, 'tool_calls')
      ]
    })
    const harness = createHarness([first, replay], { mode: 'exact_replay' })

    // When
    const labels = await collect(harness.coordinator.stream)

    // Then
    expect(labels).toEqual(['commitment', 'task', 'finish'])
    expect(harness.requestedAttempts).toEqual([1, 2])
    expect(harness.actionCommitmentRetries).toEqual([
      {
        attemptIndex: 1,
        pattern: 'zh_immediate_first_person',
        visibleChars: COMMITMENT_TEXT.length,
        availableToolCount: 94
      }
    ])
    expect(harness.replayTelemetry).toEqual([
      {
        matchedReasoningChars: 0,
        matchedVisibleChars: COMMITMENT_TEXT.length,
        matchedToolCount: 0,
        divergenceChannel: 'none',
        replayOutcome: 'caught_up',
        attempts: 2
      }
    ])
    expect(harness.completions).toEqual([
      { attemptIndex: 2, recoveryTier: 'exact_replay', recovered: false }
    ])
  })

  test('never retries the same action commitment more than once', async () => {
    // Given
    const first = makeAttempt({
      output: [
        chunk('commitment', { content: COMMITMENT_TEXT }),
        chunk('discarded-finish', {}, 'stop')
      ],
      observation: COMMITMENT_OBSERVATION
    })
    const replay = makeAttempt({
      output: [chunk('shadow', { content: COMMITMENT_TEXT }), chunk('accepted-finish', {}, 'stop')],
      observation: COMMITMENT_OBSERVATION
    })
    const unused = makeAttempt({ output: [chunk('must-not-run', {}, 'stop')] })
    const harness = createHarness([first, replay, unused], { mode: 'exact_replay' })

    // When
    const labels = await collect(harness.coordinator.stream)

    // Then
    expect(labels).toEqual(['commitment', 'accepted-finish'])
    expect(harness.requestedAttempts).toEqual([1, 2])
    expect(harness.actionCommitmentRetries).toHaveLength(1)
  })

  test('does not open a third attempt when the action-commitment replay diverges', async () => {
    // Given
    const mapped = new TestStreamFailure('action commitment replay diverged')
    const first = makeAttempt({
      output: [
        chunk('commitment', { content: COMMITMENT_TEXT }),
        chunk('discarded-finish', {}, 'stop')
      ],
      observation: COMMITMENT_OBSERVATION
    })
    const replay = makeAttempt({
      output: [chunk('divergent-shadow', { content: '不同的开头。' })]
    })
    const unused = makeAttempt({ output: [chunk('must-not-run', {}, 'stop')] })
    const harness = createHarness([first, replay, unused], {
      mode: 'exact_replay',
      mapError: () => mapped
    })
    const reader = harness.coordinator.stream.getReader()

    // When
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('commitment')

    // Then
    await expectRejection(reader.read(), mapped)
    expect(harness.requestedAttempts).toEqual([1, 2])
    expect(harness.actionCommitmentRetries).toHaveLength(1)
    expect(harness.replayTelemetry[0]?.divergenceChannel).toBe('text')
    expect(harness.completions).toEqual([])
    expect(harness.terminalCalls()).toBe(1)
  })

  test('requires every clean EOF action-commitment safety gate', async () => {
    const cases = [
      {
        name: 'completion metadata',
        observation: {
          ...COMMITMENT_OBSERVATION,
          terminalSource: 'completion_metadata_received'
        } as const,
        mode: 'exact_replay' as const,
        maxAttempts: 2
      },
      {
        name: 'available tools',
        observation: { ...COMMITMENT_OBSERVATION, availableToolCount: 0 },
        mode: 'exact_replay' as const,
        maxAttempts: 2
      },
      {
        name: 'no prior tool intent',
        observation: { ...COMMITMENT_OBSERVATION, sawToolIntent: true },
        mode: 'exact_replay' as const,
        maxAttempts: 2
      },
      {
        name: 'detected commitment',
        observation: { ...COMMITMENT_OBSERVATION, forwardActionCommitment: null },
        mode: 'exact_replay' as const,
        maxAttempts: 2
      },
      {
        name: 'exact replay mode',
        observation: COMMITMENT_OBSERVATION,
        mode: 'reasoning_restart' as const,
        maxAttempts: 2
      },
      {
        name: 'remaining attempt budget',
        observation: COMMITMENT_OBSERVATION,
        mode: 'exact_replay' as const,
        maxAttempts: 1
      }
    ]

    for (const row of cases) {
      const first = makeAttempt({
        output: [
          chunk(`${row.name}-commitment`, { content: COMMITMENT_TEXT }),
          chunk(`${row.name}-finish`, {}, 'stop')
        ],
        observation: row.observation
      })
      const unused = makeAttempt({ output: [chunk(`${row.name}-must-not-run`, {}, 'stop')] })
      const harness = createHarness([first, unused], {
        mode: row.mode,
        maxAttempts: row.maxAttempts
      })

      expect(await collect(harness.coordinator.stream)).toEqual([
        `${row.name}-commitment`,
        `${row.name}-finish`
      ])
      expect(harness.requestedAttempts).toEqual([1])
      expect(harness.actionCommitmentRetries).toEqual([])
    }
  })

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

  test('matches a multibyte prefix re-split at different boundaries', async () => {
    // Given
    const first = makeAttempt({
      output: [chunk('first-1', { content: '你好' }), chunk('first-2', { content: '，世界' })],
      observation: { emitted: { visibleChars: 5, toolCount: 0 }, sawToolIntent: false },
      failure: new TestStreamFailure('failed after multibyte prefix')
    })
    const replay = makeAttempt({
      output: [
        chunk('shadow-1', { content: '你' }),
        chunk('shadow-2', { content: '好，世' }),
        chunk('suffix', { content: '界！' }),
        chunk('finish', {}, 'stop')
      ]
    })
    const harness = createHarness([first, replay], { mode: 'exact_replay' })

    // When
    const labels = await collect(harness.coordinator.stream)

    // Then
    expect(labels).toEqual(['first-1', 'first-2', 'suffix', 'finish'])
    expect(harness.replayTelemetry).toEqual([
      {
        matchedReasoningChars: 0,
        matchedVisibleChars: 5,
        matchedToolCount: 0,
        divergenceChannel: 'none',
        replayOutcome: 'caught_up',
        attempts: 2
      }
    ])
  })

  test('consumes one budget slot per tool identity divergence without leaking a shadow tool', async () => {
    // Given
    const delivered = [toolCall(0, 'tool-1', 'read', '{"path":"/a"}')]
    const first = makeAttempt({
      output: [chunk('first-tools', { tool_calls: delivered })],
      observation: { emitted: { visibleChars: 0, toolCount: 1 }, sawToolIntent: true },
      failure: new TestStreamFailure('failed after one tool')
    })
    const renamedId = makeAttempt({
      output: [chunk('leaked-id', { tool_calls: [toolCall(0, 'tool-9', 'read', '{"path":"/a"}')] })]
    })
    const renamedName = makeAttempt({
      output: [
        chunk('leaked-name', { tool_calls: [toolCall(0, 'tool-1', 'write', '{"path":"/a"}')] })
      ]
    })
    const recovered = makeAttempt({
      output: [chunk('matched-tools', { tool_calls: delivered }), chunk('finish', {}, 'tool_calls')]
    })
    const harness = createHarness([first, renamedId, renamedName, recovered], {
      mode: 'exact_replay'
    })

    // When
    const labels = await collect(harness.coordinator.stream)

    // Then
    expect(labels).toEqual(['first-tools', 'finish'])
    expect(harness.requestedAttempts).toEqual([1, 2, 3, 4])
    expect(
      harness.replayTelemetry.map(({ replayOutcome, divergenceChannel, matchedToolCount }) => ({
        replayOutcome,
        divergenceChannel,
        matchedToolCount
      }))
    ).toEqual([
      { replayOutcome: 'diverged', divergenceChannel: 'tool', matchedToolCount: 0 },
      { replayOutcome: 'diverged', divergenceChannel: 'tool', matchedToolCount: 0 },
      { replayOutcome: 'caught_up', divergenceChannel: 'none', matchedToolCount: 1 }
    ])
  })

  test('holds a mismatched tool argument stream back until its terminal chunk diverges', async () => {
    // Given
    const first = makeAttempt({
      output: [
        chunk('first-tools', { tool_calls: [toolCall(0, 'tool-1', 'read', '{"path":"/a"}')] })
      ],
      observation: { emitted: { visibleChars: 0, toolCount: 1 }, sawToolIntent: true },
      failure: new TestStreamFailure('failed after one tool')
    })
    const wrongArguments = makeAttempt({
      output: [
        chunk('leaked-open', { tool_calls: [toolCall(0, 'tool-1', 'read', '{"path":')] }),
        chunk('leaked-close', { tool_calls: [toolCall(0, 'tool-1', 'read', '"/b"}')] }),
        chunk('leaked-finish', {}, 'tool_calls')
      ]
    })
    const recovered = makeAttempt({
      output: [
        chunk('matched-tools', { tool_calls: [toolCall(0, 'tool-1', 'read', '{"path":"/a"}')] }),
        chunk('finish', {}, 'tool_calls')
      ]
    })
    const harness = createHarness([first, wrongArguments, recovered], { mode: 'exact_replay' })

    // When
    const labels = await collect(harness.coordinator.stream)

    // Then
    expect(labels).toEqual(['first-tools', 'finish'])
    expect(harness.replayTelemetry[0]).toEqual({
      matchedReasoningChars: 0,
      matchedVisibleChars: 0,
      matchedToolCount: 0,
      divergenceChannel: 'tool',
      replayOutcome: 'diverged',
      attempts: 2
    })
  })

  test('spends every remaining budget slot on divergent replays and then maps one terminal error', async () => {
    // Given
    const mapped = new TestStreamFailure('exact replay budget exhausted')
    const first = makeAttempt({
      output: [chunk('first', { content: 'hello world' })],
      observation: VISIBLE_OBSERVATION,
      failure: new TestStreamFailure('first failure')
    })
    const divergent = (label: string): AttemptHandle =>
      makeAttempt({ output: [chunk(label, { content: 'hello wurld' })] })
    const harness = createHarness([first, divergent('leak-2'), divergent('leak-3')], {
      mode: 'exact_replay',
      maxAttempts: 3,
      mapError: () => mapped
    })
    const reader = harness.coordinator.stream.getReader()

    // When
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')

    // Then
    await expectRejection(reader.read(), mapped)
    expect(harness.requestedAttempts).toEqual([1, 2, 3])
    expect(harness.replayTelemetry).toHaveLength(2)
    expect(harness.replayTelemetry.map((entry) => entry.attempts)).toEqual([2, 3])
    expect(harness.completions).toEqual([])
    expect(harness.terminalCalls()).toBe(1)
  })

  test('abort while a shadow replay is withheld terminates once and reports no divergence', async () => {
    // Given
    const controller = new AbortController()
    const withheld = Promise.withResolvers<void>()
    let closeCalls = 0
    let reads = 0
    const stalledReplay: AttemptHandle = {
      chunks: {
        next: async () => {
          reads++
          if (reads === 1) return { done: false, value: chunk('shadow', { content: 'hello' }) }
          withheld.resolve()
          return new Promise<IteratorResult<unknown>>(() => {})
        }
      },
      observed: () => EMPTY_OBSERVATION,
      close: async () => {
        closeCalls++
      }
    }
    const first = makeAttempt({
      output: [chunk('first', { content: 'hello world' })],
      observation: VISIBLE_OBSERVATION,
      failure: new TestStreamFailure('first failure')
    })
    const harness = createHarness([first, stalledReplay], {
      mode: 'exact_replay',
      maxAttempts: 3,
      signal: controller.signal
    })
    const reader = harness.coordinator.stream.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
    const pendingRead = reader.read()
    await withheld.promise

    // When
    const reason = new DOMException('cancelled while withholding', 'AbortError')
    controller.abort(reason)

    // Then
    await expectRejection(pendingRead, reason)
    await Promise.resolve()
    expect(closeCalls).toBe(1)
    expect(harness.replayTelemetry).toEqual([])
    expect(harness.requestedAttempts).toEqual([1, 2])
    expect(harness.terminalCalls()).toBe(1)
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
