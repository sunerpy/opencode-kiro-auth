import { describe, expect, test } from 'bun:test'
import type { RecoveryAttemptFactory } from '../core/request/recovery-attempt.js'
import {
  createLiveRecoveryResponse,
  type LiveRecoveryOptions
} from '../core/request/recovery-integration.js'
import type { ManagedAccount } from '../plugin/types.js'

class InitialAttemptError extends Error {
  override readonly name = 'InitialAttemptError'
}

function makeAccount(): ManagedAccount {
  return {
    id: 'A',
    email: 'A@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: 'refresh-A',
    accessToken: 'access-A',
    expiresAt: Date.now() + 60_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0
  }
}

function recoveryOptions(
  attemptFactory: Pick<RecoveryAttemptFactory, 'open'>,
  signal: AbortSignal = new AbortController().signal
): {
  readonly options: LiveRecoveryOptions
  readonly terminalCalls: () => number
  readonly initialFailureCalls: () => number
} {
  let terminalCalls = 0
  let initialFailureCalls = 0
  return {
    options: {
      mode: 'reasoning_restart',
      maxAttempts: 3,
      priorStreamFailures: 0,
      signal,
      initialAccount: makeAccount(),
      attemptFactory,
      retryDelay: () => 0,
      wait: async () => {},
      selectAlternativeAccount: async () => null,
      describeError: (error) => error,
      onTerminal: () => {
        terminalCalls++
      },
      onInitialOpenFailure: () => {
        initialFailureCalls++
      },
      onCancel: () => {}
    },
    terminalCalls: () => terminalCalls,
    initialFailureCalls: () => initialFailureCalls
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error
  )
}

describe('createLiveRecoveryResponse — initial attempt terminal ownership', () => {
  test('a synchronous initial factory throw propagates and releases the attempt only', async () => {
    const original = new InitialAttemptError('synchronous initial open failure')
    const harness = recoveryOptions({
      open() {
        throw original
      }
    })

    const caught = await rejectionOf(createLiveRecoveryResponse(harness.options))

    expect(caught).toBe(original)
    expect(harness.initialFailureCalls()).toBe(1)
    expect(harness.terminalCalls()).toBe(0)
  })

  test('an asynchronous initial factory rejection propagates and releases the attempt only', async () => {
    const original = new InitialAttemptError('asynchronous initial open failure')
    const harness = recoveryOptions({
      open: () => Promise.reject(original)
    })

    const caught = await rejectionOf(createLiveRecoveryResponse(harness.options))

    expect(caught).toBe(original)
    expect(harness.initialFailureCalls()).toBe(1)
    expect(harness.terminalCalls()).toBe(0)
  })

  test('an already aborted request propagates its reason and releases the attempt only', async () => {
    const reason = new DOMException('cancelled before initial open', 'AbortError')
    const controller = new AbortController()
    controller.abort(reason)
    const harness = recoveryOptions(
      {
        open: () => Promise.reject(reason)
      },
      controller.signal
    )

    const caught = await rejectionOf(createLiveRecoveryResponse(harness.options))

    expect(caught).toBe(reason)
    expect(harness.initialFailureCalls()).toBe(1)
    expect(harness.terminalCalls()).toBe(0)
  })

  test('an abort during initial open propagates its reason and releases the attempt only', async () => {
    const controller = new AbortController()
    const aborted = Promise.withResolvers<never>()
    const harness = recoveryOptions(
      {
        open: () => aborted.promise
      },
      controller.signal
    )
    const opening = createLiveRecoveryResponse(harness.options)
    const reason = new DOMException('cancelled during initial open', 'AbortError')

    controller.abort(reason)
    aborted.reject(reason)

    const caught = await rejectionOf(opening)

    expect(caught).toBe(reason)
    expect(harness.initialFailureCalls()).toBe(1)
    expect(harness.terminalCalls()).toBe(0)
  })

  test('a delivered response keeps request-level terminal ownership exactly once', async () => {
    const drained: IteratorResult<unknown> = { done: true, value: undefined }
    let closeCalls = 0
    let completeCalls = 0
    const harness = recoveryOptions({
      open: async () => ({
        account: makeAccount(),
        logDetails: () => ({}),
        handle: {
          chunks: { next: async () => drained, return: async () => drained },
          observed: () => ({ emitted: { visibleChars: 0, toolCount: 0 }, sawToolIntent: false }),
          close: async () => {
            closeCalls++
          },
          complete: async () => {
            completeCalls++
          }
        }
      })
    })

    const response = await createLiveRecoveryResponse(harness.options)
    await response.text()

    expect(completeCalls).toBe(1)
    expect(closeCalls).toBeGreaterThanOrEqual(1)
    expect(harness.terminalCalls()).toBe(1)
    expect(harness.initialFailureCalls()).toBe(0)
  })
})
