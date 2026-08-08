import { describe, expect, spyOn, test } from 'bun:test'
import type { RecoveryAttemptFactory } from '../core/request/recovery-attempt.js'
import {
  createLiveRecoveryResponse,
  type LiveRecoveryOptions
} from '../core/request/recovery-integration.js'
import type { SdkStreamingAttempt } from '../core/request/response-handler.js'
import {
  STREAM_ACTION_COMMITMENT_RETRY_LOG,
  STREAM_EMPTY_CLEAN_EOF_RETRY_LOG
} from '../core/request/stream-log-events.js'
import { AccountManager } from '../plugin/accounts.js'
import * as logger from '../plugin/logger.js'
import type { ManagedAccount } from '../plugin/types.js'
import { chunk, makeAttempt, TestStreamFailure } from './stream-recovery.fixture.js'

class InitialAttemptError extends Error {
  override readonly name = 'InitialAttemptError'
}

function makeAccount(id = 'A'): ManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: `refresh-${id}`,
    accessToken: `access-${id}`,
    expiresAt: Date.now() + 60_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function recoveryOptions(
  attemptFactory: Pick<RecoveryAttemptFactory, 'open'>,
  signal: AbortSignal = new AbortController().signal
): {
  readonly options: LiveRecoveryOptions
  readonly terminalCalls: () => number
  readonly terminalRecords: () => readonly Record<string, unknown>[]
  readonly initialFailureCalls: () => number
} {
  let terminalCalls = 0
  const terminalRecords: Record<string, unknown>[] = []
  let initialFailureCalls = 0
  return {
    options: {
      mode: 'reasoning_restart',
      maxAttempts: 3,
      priorStreamFailures: 0,
      signal,
      initialAccount: makeAccount(),
      failedAccountIds: new Set<string>(),
      attemptFactory,
      retryDelay: () => 0,
      wait: async () => {},
      selectAlternativeAccount: async () => null,
      markRateLimited: () => {},
      describeError: (error) => error,
      onTerminal: (details) => {
        terminalCalls++
        terminalRecords.push(details)
      },
      onInitialOpenFailure: () => {
        initialFailureCalls++
      },
      onCancel: () => {}
    },
    terminalCalls: () => terminalCalls,
    terminalRecords: () => terminalRecords,
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

describe('createLiveRecoveryResponse — account rotation', () => {
  test('final recovery open failure emits one terminal record with carried request identity', async () => {
    const streamFailure = new TestStreamFailure('initial stream interrupted')
    const openFailure = new Error('final recovery open failed')
    const attemptFactory: Pick<RecoveryAttemptFactory, 'open'> = {
      open: async (attemptIndex, selectedAccount) => {
        if (attemptIndex === 2) throw openFailure
        return {
          account: selectedAccount,
          logDetails: (details = {}) => ({
            conversationId: 'conversation-open-terminal',
            model: 'claude-opus-5-max',
            processId: 45678,
            ...details
          }),
          handle: {
            ...makeAttempt({ output: [], failure: streamFailure }),
            complete: async () => {}
          }
        }
      }
    }
    const harness = recoveryOptions(attemptFactory)

    const response = await createLiveRecoveryResponse({
      ...harness.options,
      maxAttempts: 2
    })
    await rejectionOf(response.text())

    expect(harness.terminalRecords()).toEqual([
      expect.objectContaining({
        conversationId: 'conversation-open-terminal',
        model: 'claude-opus-5-max',
        processId: 45678,
        identitySource: 'previous_attempt',
        attemptIndex: 2,
        phase: 'pre_stream_open',
        outcome: 'terminal',
        attemptsUsed: 2,
        accountsTried: 1,
        accountAliases: [expect.stringMatching(/^account-\d+$/)],
        initialFailure: streamFailure,
        finalFailure: openFailure,
        recovered: false,
        quotaRelevant: false,
        terminalSource: 'stream_attempt_budget_exhausted'
      })
    ])
    expect(harness.terminalCalls()).toBe(1)
  })

  test('final exact replay early end outranks the attempt clean EOF terminal source', async () => {
    const streamFailure = new TestStreamFailure('initial exact replay stream interrupted')
    const attemptFactory: Pick<RecoveryAttemptFactory, 'open'> = {
      open: async (attemptIndex, selectedAccount) => ({
        account: selectedAccount,
        logDetails: (details = {}) => ({
          conversationId: 'conversation-early-end-terminal',
          model: 'claude-opus-5-max',
          terminalSource:
            attemptIndex === 1 ? 'iterator_failure' : 'clean_eof_without_completion_metadata',
          ...details
        }),
        handle: {
          ...(attemptIndex === 1
            ? makeAttempt({
                output: [chunk('early-end-prefix', { content: 'delivered prefix' })],
                failure: streamFailure
              })
            : makeAttempt({ output: [] })),
          complete: async () => {}
        }
      })
    }
    const harness = recoveryOptions(attemptFactory)

    const response = await createLiveRecoveryResponse({
      ...harness.options,
      mode: 'exact_replay',
      maxAttempts: 2
    })
    await rejectionOf(response.text())

    expect(harness.terminalRecords()).toEqual([
      expect.objectContaining({
        conversationId: 'conversation-early-end-terminal',
        phase: 'stream_iteration',
        outcome: 'terminal',
        terminalSource: 'stream_attempt_budget_exhausted'
      })
    ])
  })

  test('coordinator serialization failure outranks an observer-recorded clean EOF', async () => {
    const circularChunk: Record<string, unknown> = {
      choices: [{ delta: { content: 'unserializable' }, finish_reason: null }]
    }
    circularChunk['self'] = circularChunk
    const attemptFactory: Pick<RecoveryAttemptFactory, 'open'> = {
      open: async (_attemptIndex, selectedAccount) => ({
        account: selectedAccount,
        logDetails: (details = {}) => ({
          conversationId: 'conversation-coordinator-failure',
          terminalSource: 'clean_eof_without_completion_metadata',
          ...details
        }),
        handle: {
          ...makeAttempt({ output: [circularChunk] }),
          complete: async () => {}
        }
      })
    }
    const harness = recoveryOptions(attemptFactory)

    const response = await createLiveRecoveryResponse(harness.options)
    await rejectionOf(response.text())

    expect(harness.terminalRecords()).toEqual([
      expect.objectContaining({
        conversationId: 'conversation-coordinator-failure',
        phase: 'stream_iteration',
        outcome: 'terminal',
        terminalSource: 'stream_processing_failure'
      })
    ])
  })

  test('rotates from A through quota-exhausted B to C without retrying B', async () => {
    const accountA = makeAccount('A')
    const accountB = makeAccount('B')
    const accountC = makeAccount('C')
    const openedAccountIds: string[] = []
    const excludedAccountIds: string[][] = []
    const quotaError = new Error('You have reached the limit.')
    quotaError.name = 'ServiceQuotaExceededException'

    const handle = (output: readonly unknown[], failure?: Error): SdkStreamingAttempt => ({
      ...makeAttempt({ output, failure }),
      complete: async () => {}
    })
    const attemptFactory: Pick<RecoveryAttemptFactory, 'open'> = {
      open: async (attemptIndex, selectedAccount) => {
        openedAccountIds.push(selectedAccount.id)
        if (selectedAccount.id === accountB.id) throw quotaError

        return {
          account: selectedAccount,
          logDetails: (details = {}) => ({ account: selectedAccount.email, ...details }),
          handle:
            attemptIndex === 1
              ? handle(
                  [chunk('A-prefix', { content: 'prefix' })],
                  new TestStreamFailure('A stream interrupted')
                )
              : handle([
                  chunk('C-replay', { content: 'prefix' }),
                  chunk('C-suffix', { content: ' recovered' }),
                  chunk('C-terminal', {}, 'stop')
                ])
        }
      }
    }
    const harness = recoveryOptions(attemptFactory)
    const selectAlternativeAccount = async (
      excludedIds: ReadonlySet<string>
    ): Promise<ManagedAccount | null> => {
      const excluded = new Set(excludedIds)
      excludedAccountIds.push([...excluded].sort())
      return [accountB, accountC].find((account) => !excluded.has(account.id)) ?? null
    }

    const response = await createLiveRecoveryResponse({
      ...harness.options,
      mode: 'exact_replay',
      maxAttempts: 3,
      priorStreamFailures: 1,
      initialAccount: accountA,
      selectAlternativeAccount
    })
    const streamFailure = await rejectionOf(response.text())

    expect(openedAccountIds).toEqual(['A', 'B', 'C'])
    expect(excludedAccountIds).toEqual([['A'], ['A', 'B']])
    expect(streamFailure).toBeUndefined()
  })

  test('quota failure applies a bounded cooldown without marking the account unhealthy', async () => {
    const accountA = makeAccount('quota-recovery-A')
    const accountB = makeAccount('quota-recovery-B')
    const accountManager = new AccountManager([accountA, accountB], 'sticky')
    const markRateLimited = spyOn(accountManager, 'markRateLimited')
    const markUnhealthy = spyOn(accountManager, 'markUnhealthy')
    const quotaError = new Error('You have reached the limit.')
    quotaError.name = 'ServiceQuotaExceededException'
    const handle = (output: readonly unknown[], failure?: Error): SdkStreamingAttempt => ({
      ...makeAttempt({ output, failure }),
      complete: async () => {}
    })
    const attemptFactory: Pick<RecoveryAttemptFactory, 'open'> = {
      open: async (attemptIndex, selectedAccount) => ({
        account: selectedAccount,
        logDetails: () => ({}),
        handle:
          attemptIndex === 1
            ? handle([], quotaError)
            : handle([chunk('quota-recovered', { content: 'recovered' }, 'stop')])
      })
    }
    const harness = recoveryOptions(attemptFactory)
    const before = Date.now()

    const response = await createLiveRecoveryResponse({
      ...harness.options,
      maxAttempts: 2,
      initialAccount: accountA,
      selectAlternativeAccount: async () => accountB,
      markRateLimited: (account, milliseconds) =>
        accountManager.markRateLimited(account, milliseconds)
    })
    await response.text()

    const refreshedA = accountManager.getAccounts().find((account) => account.id === accountA.id)
    expect(markRateLimited).toHaveBeenCalledTimes(1)
    expect(markRateLimited.mock.calls[0]?.[0]).toBe(accountA)
    expect(markRateLimited.mock.calls[0]?.[1]).toBeGreaterThan(0)
    expect(markRateLimited.mock.calls[0]?.[1]).toBeLessThanOrEqual(30_000)
    expect(refreshedA?.rateLimitResetTime).toBeGreaterThan(before)
    expect(refreshedA?.rateLimitResetTime).toBeLessThanOrEqual(Date.now() + 30_000)
    expect(refreshedA?.isHealthy).toBe(true)
    expect(markUnhealthy).toHaveBeenCalledTimes(0)
    expect(harness.terminalRecords()).toEqual([
      expect.objectContaining({
        attemptsUsed: 2,
        accountsTried: 2,
        initialFailure: quotaError,
        finalFailure: quotaError,
        recovered: true,
        quotaRelevant: true
      })
    ])
  })

  test('pre-stream open failure retry log carries only prior stable request identity', async () => {
    const accountA = makeAccount('log-A')
    const accountB = makeAccount('log-B')
    const accountC = makeAccount('log-C')
    const quotaError = new Error('You have reached the limit.')
    quotaError.name = 'ServiceQuotaExceededException'
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const handle = (output: readonly unknown[], failure?: Error): SdkStreamingAttempt => ({
      ...makeAttempt({ output, failure }),
      complete: async () => {}
    })
    const attemptFactory: Pick<RecoveryAttemptFactory, 'open'> = {
      open: async (attemptIndex, selectedAccount) => {
        if (selectedAccount.id === accountB.id) throw quotaError
        return {
          account: selectedAccount,
          logDetails: (details = {}) => ({
            conversationId: 'conversation-log-correlation',
            model: 'claude-opus-5-max',
            processId: 34567,
            streamAttempt: 7,
            region: 'eu-west-1',
            streamStartedAt: 'stale-start',
            eventTypeCounts: { staleEvent: 2 },
            upstreamEventCount: 17,
            emittedReasoningChars: 4,
            emittedVisibleChars: 6,
            emittedToolCount: 1,
            sawToolIntent: true,
            ...details
          }),
          handle:
            attemptIndex === 1
              ? handle(
                  [chunk('log-A-prefix', { content: 'prefix' })],
                  new TestStreamFailure('A stream interrupted')
                )
              : handle([
                  chunk('log-C-replay', { content: 'prefix' }),
                  chunk('log-C-terminal', {}, 'stop')
                ])
        }
      }
    }
    const harness = recoveryOptions(attemptFactory)
    const selectAlternativeAccount = async (
      excludedIds: ReadonlySet<string>
    ): Promise<ManagedAccount | null> =>
      [accountB, accountC].find((account) => !excludedIds.has(account.id)) ?? null

    try {
      const response = await createLiveRecoveryResponse({
        ...harness.options,
        mode: 'exact_replay',
        maxAttempts: 3,
        priorStreamFailures: 1,
        initialAccount: accountA,
        selectAlternativeAccount
      })
      await response.text()

      const preStreamRecord = warn.mock.calls
        .map((call) => call[1])
        .find(
          (details): details is Record<string, unknown> =>
            isRecord(details) && details['phase'] === 'pre_stream_open'
        )
      expect(preStreamRecord).toMatchObject({
        conversationId: 'conversation-log-correlation',
        model: 'claude-opus-5-max',
        processId: 34567,
        identitySource: 'previous_attempt',
        attemptedAccountAlias: expect.stringMatching(/^account-\d+$/)
      })
      expect(JSON.stringify(preStreamRecord)).not.toContain(accountB.id)
      expect(JSON.stringify(preStreamRecord)).not.toContain(accountB.email)
      expect(preStreamRecord).not.toHaveProperty('upstreamEventCount')
      expect(preStreamRecord).not.toHaveProperty('streamAttempt')
      expect(preStreamRecord).not.toHaveProperty('region')
      expect(preStreamRecord).not.toHaveProperty('streamStartedAt')
      expect(preStreamRecord).not.toHaveProperty('eventTypeCounts')
      expect(preStreamRecord).not.toHaveProperty('emittedReasoningChars')
      expect(preStreamRecord).not.toHaveProperty('emittedVisibleChars')
      expect(preStreamRecord).not.toHaveProperty('emittedToolCount')
      expect(preStreamRecord).not.toHaveProperty('sawToolIntent')
    } finally {
      warn.mockRestore()
    }
  })

  test('action-commitment replay does not classify or rotate the healthy account', async () => {
    const commitment = '我现在派两个并行任务。'
    const account = makeAccount('commitment')
    let selectCalls = 0
    let markRateLimitedCalls = 0
    let retryDelayCalls = 0
    let waitCalls = 0
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const attemptFactory: Pick<RecoveryAttemptFactory, 'open'> = {
      open: async (attemptIndex, selectedAccount) => ({
        account: selectedAccount,
        logDetails: (details = {}) => ({
          conversationId: 'conversation-action-commitment',
          model: 'claude-opus-5-xhigh',
          terminalSource: 'clean_eof_without_completion_metadata',
          ...details
        }),
        handle: {
          ...(attemptIndex === 1
            ? makeAttempt({
                output: [
                  chunk('commitment', { content: commitment }),
                  chunk('discarded-finish', {}, 'stop')
                ],
                observation: {
                  emitted: { visibleChars: commitment.length, toolCount: 0 },
                  sawToolIntent: false,
                  terminalSource: 'clean_eof_without_completion_metadata',
                  availableToolCount: 94,
                  forwardActionCommitment: 'zh_immediate_first_person'
                }
              })
            : makeAttempt({
                output: [
                  chunk('shadow', { content: commitment }),
                  chunk('task', {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'tool-1',
                        function: { name: 'task', arguments: '{"description":"fix"}' }
                      }
                    ]
                  }),
                  chunk('finish', {}, 'tool_calls')
                ]
              })),
          complete: async () => {}
        }
      })
    }
    const harness = recoveryOptions(attemptFactory)

    try {
      const response = await createLiveRecoveryResponse({
        ...harness.options,
        mode: 'exact_replay',
        initialAccount: account,
        retryDelay: () => {
          retryDelayCalls++
          return 0
        },
        wait: async () => {
          waitCalls++
        },
        selectAlternativeAccount: async () => {
          selectCalls++
          return null
        },
        markRateLimited: () => {
          markRateLimitedCalls++
        }
      })
      await response.text()

      expect(harness.options.failedAccountIds).toEqual(new Set())
      expect(selectCalls).toBe(0)
      expect(markRateLimitedCalls).toBe(0)
      expect(retryDelayCalls).toBe(0)
      expect(waitCalls).toBe(0)
      expect(
        warn.mock.calls.filter((call) => call[0] === 'Kiro SDK event stream iteration failed')
      ).toEqual([])
      expect(
        warn.mock.calls.find((call) => call[0] === STREAM_ACTION_COMMITMENT_RETRY_LOG)?.[1]
      ).toMatchObject({
        outcome: 'retrying',
        recoveryTrigger: 'clean_eof_action_commitment',
        actionCommitmentPattern: 'zh_immediate_first_person',
        actionCommitmentVisibleChars: commitment.length,
        availableToolCount: 94,
        nextAttempt: 2
      })
      expect(harness.terminalRecords()).toEqual([
        expect.objectContaining({
          conversationId: 'conversation-action-commitment',
          attemptsUsed: 2,
          accountsTried: 1,
          initialFailure: null,
          finalFailure: null,
          recovered: true,
          quotaRelevant: false,
          terminalSource: 'clean_eof_without_completion_metadata'
        })
      ])
    } finally {
      warn.mockRestore()
    }
  })

  test('empty clean EOF retry does not classify, delay, or rotate the healthy account', async () => {
    const account = makeAccount('empty-eof')
    const selectedAccountIds: string[] = []
    let selectCalls = 0
    let markRateLimitedCalls = 0
    let retryDelayCalls = 0
    let waitCalls = 0
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const attemptFactory: Pick<RecoveryAttemptFactory, 'open'> = {
      open: async (attemptIndex, selectedAccount) => {
        selectedAccountIds.push(selectedAccount.id)
        return {
          account: selectedAccount,
          logDetails: (details = {}) => ({
            conversationId: 'conversation-empty-clean-eof',
            model: 'claude-opus-5-max',
            terminalSource: 'clean_eof_without_completion_metadata',
            ...details
          }),
          handle: {
            ...(attemptIndex === 1
              ? makeAttempt({
                  output: [chunk('discarded-empty-finish', {}, 'stop')],
                  observation: {
                    emitted: { visibleChars: 0, toolCount: 0 },
                    sawToolIntent: false,
                    terminalSource: 'clean_eof_without_completion_metadata'
                  }
                })
              : makeAttempt({
                  output: [
                    chunk('continued', { content: 'continued after tool error' }),
                    chunk('finish', {}, 'stop')
                  ]
                })),
            complete: async () => {}
          }
        }
      }
    }
    const harness = recoveryOptions(attemptFactory)

    try {
      const response = await createLiveRecoveryResponse({
        ...harness.options,
        mode: 'exact_replay',
        maxAttempts: 2,
        initialAccount: account,
        retryDelay: () => {
          retryDelayCalls++
          return 0
        },
        wait: async () => {
          waitCalls++
        },
        selectAlternativeAccount: async () => {
          selectCalls++
          return null
        },
        markRateLimited: () => {
          markRateLimitedCalls++
        }
      })
      await response.text()

      expect(selectedAccountIds).toEqual([account.id, account.id])
      expect(harness.options.failedAccountIds).toEqual(new Set())
      expect(selectCalls).toBe(0)
      expect(markRateLimitedCalls).toBe(0)
      expect(retryDelayCalls).toBe(0)
      expect(waitCalls).toBe(0)
      expect(
        warn.mock.calls.filter((call) => call[0] === 'Kiro SDK event stream iteration failed')
      ).toEqual([])
      expect(
        warn.mock.calls.find((call) => call[0] === STREAM_EMPTY_CLEAN_EOF_RETRY_LOG)?.[1]
      ).toMatchObject({
        outcome: 'retrying',
        recoveryTrigger: 'clean_eof_empty_response',
        nextAttempt: 2
      })
      expect(harness.terminalRecords()).toEqual([
        expect.objectContaining({
          conversationId: 'conversation-empty-clean-eof',
          attemptsUsed: 2,
          accountsTried: 1,
          initialFailure: null,
          finalFailure: null,
          recovered: true,
          quotaRelevant: false,
          terminalSource: 'clean_eof_without_completion_metadata'
        })
      ])
    } finally {
      warn.mockRestore()
    }
  })
})
