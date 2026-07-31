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
): { readonly options: LiveRecoveryOptions; readonly terminalCalls: () => number } {
  let terminalCalls = 0
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
      onCancel: () => {}
    },
    terminalCalls: () => terminalCalls
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error
  )
}

describe('createLiveRecoveryResponse — initial attempt terminal ownership', () => {
  test('a synchronous initial factory throw propagates and terminates exactly once', async () => {
    const original = new InitialAttemptError('synchronous initial open failure')
    const harness = recoveryOptions({
      open() {
        throw original
      }
    })

    const caught = await rejectionOf(createLiveRecoveryResponse(harness.options))

    expect(caught).toBe(original)
    expect(harness.terminalCalls()).toBe(1)
  })

  test('an asynchronous initial factory rejection propagates and terminates exactly once', async () => {
    const original = new InitialAttemptError('asynchronous initial open failure')
    const harness = recoveryOptions({
      open: () => Promise.reject(original)
    })

    const caught = await rejectionOf(createLiveRecoveryResponse(harness.options))

    expect(caught).toBe(original)
    expect(harness.terminalCalls()).toBe(1)
  })

  test('an abort during initial open propagates its reason and terminates exactly once', async () => {
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
    expect(harness.terminalCalls()).toBe(1)
  })
})
