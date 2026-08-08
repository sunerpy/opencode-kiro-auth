import { expect } from 'bun:test'
import {
  StreamRecoveryCoordinator,
  type ActionCommitmentRetryTelemetry,
  type AttemptHandle,
  type AttemptObservation,
  type EmptyCleanEofRetryTelemetry,
  type ReplayAttemptTelemetry,
  type StreamRecoveryCompletion,
  type StreamRecoveryMode
} from '../core/request/stream-recovery.js'

export class TestStreamFailure extends Error {
  override readonly name = 'TestStreamFailure'
}

type AttemptSpec = {
  readonly output: readonly unknown[]
  readonly observation?: AttemptObservation
  readonly failure?: Error
}

type HarnessOverrides = {
  readonly mode?: StreamRecoveryMode
  readonly maxAttempts?: number
  readonly signal?: AbortSignal
  readonly delayFn?: (attemptIndex: number, signal: AbortSignal) => Promise<void>
  readonly mapError?: (failure: unknown) => Error
}

export const EMPTY_OBSERVATION: AttemptObservation = {
  emitted: { visibleChars: 0, toolCount: 0 },
  sawToolIntent: false
}

export const ELIGIBLE = {
  mode: 'reasoning_restart',
  emitted: { visibleChars: 0, toolCount: 0 },
  sawToolIntent: false
} as const

export function chunk(
  label: string,
  delta: Readonly<Record<string, unknown>> = {},
  finishReason: string | null = null
): unknown {
  return { label, choices: [{ delta, finish_reason: finishReason }] }
}

async function* outputThenFailure(spec: AttemptSpec): AsyncGenerator<unknown> {
  for (const value of spec.output) yield value
  if (spec.failure) throw spec.failure
}

export function makeAttempt(spec: AttemptSpec): AttemptHandle {
  const chunks = outputThenFailure(spec)
  return {
    chunks,
    observed: () => spec.observation ?? EMPTY_OBSERVATION,
    close: async () => {
      await chunks.return(undefined)
    }
  }
}

export function reasoningFailure(message: string, label = 'reasoning'): AttemptHandle {
  return makeAttempt({
    output: [chunk(label, { reasoning_content: 'partial' })],
    failure: new TestStreamFailure(message)
  })
}

function labelOf(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'label' in value) {
    const label = value.label
    if (typeof label === 'string') return label
  }
  throw new TypeError('Test chunk has no label')
}

export function createHarness(
  attempts: readonly AttemptHandle[],
  overrides: HarnessOverrides = {}
) {
  const requestedAttempts: number[] = []
  const completions: StreamRecoveryCompletion[] = []
  const replayTelemetry: ReplayAttemptTelemetry[] = []
  const actionCommitmentRetries: ActionCommitmentRetryTelemetry[] = []
  const emptyCleanEofRetries: EmptyCleanEofRetryTelemetry[] = []
  let terminalCalls = 0
  const signal = overrides.signal ?? new AbortController().signal
  const coordinator = new StreamRecoveryCoordinator({
    mode: overrides.mode ?? 'reasoning_restart',
    maxAttempts: overrides.maxAttempts ?? attempts.length,
    signal,
    attemptFactory: async (attemptIndex) => {
      requestedAttempts.push(attemptIndex)
      const attempt = attempts[attemptIndex - 1]
      if (!attempt) throw new RangeError(`No attempt ${attemptIndex}`)
      return attempt
    },
    delayFn: overrides.delayFn ?? (async () => {}),
    mapError:
      overrides.mapError ??
      ((failure) => new TestStreamFailure('mapped stream failure', { cause: failure })),
    encodeChunk: (value) => new TextEncoder().encode(labelOf(value)),
    onComplete: (completion) => {
      completions.push(completion)
    },
    onReplayAttempt: (telemetry) => {
      replayTelemetry.push(telemetry)
    },
    onActionCommitmentRetry: (telemetry) => {
      actionCommitmentRetries.push(telemetry)
    },
    onEmptyCleanEofRetry: (telemetry) => {
      emptyCleanEofRetries.push(telemetry)
    },
    onTerminal: () => {
      terminalCalls++
    }
  })
  return {
    coordinator,
    requestedAttempts,
    completions,
    replayTelemetry,
    actionCommitmentRetries,
    emptyCleanEofRetries,
    terminalCalls: () => terminalCalls
  }
}

export async function collect(stream: ReadableStream<Uint8Array>): Promise<readonly string[]> {
  const reader = stream.getReader()
  const labels: string[] = []
  while (true) {
    const item = await reader.read()
    if (item.done) return labels
    labels.push(new TextDecoder().decode(item.value))
  }
}

export async function expectRejection(promise: Promise<unknown>, expected: Error): Promise<void> {
  try {
    await promise
  } catch (failure) {
    if (failure instanceof Error) {
      expect(failure).toBe(expected)
      return
    }
    throw new TestStreamFailure('Promise rejected with a non-Error value', { cause: failure })
  }
  throw new TestStreamFailure('Expected promise rejection')
}
