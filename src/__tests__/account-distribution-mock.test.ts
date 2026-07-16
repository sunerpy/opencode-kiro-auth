import { describe, expect, test } from 'bun:test'
import { AccountManager } from '../plugin/accounts.js'
import type { ManagedAccount } from '../plugin/types.js'

function makeAccount(id: string): ManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: `refresh-${id}`,
    accessToken: `access-${id}`,
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 0,
    limitCount: 10_000,
    overageCount: 0
  }
}

describe('mock cross-process account distribution', () => {
  test('K managers with distinct start indices cover K distinct first picks', () => {
    const stableAccountIds = ['account-e', 'account-a', 'account-d', 'account-b', 'account-c']
    const processCount = stableAccountIds.length

    const picks = Array.from({ length: processCount }, (_, startIndex) => {
      const accounts = stableAccountIds.map(makeAccount)
      const manager = new AccountManager(accounts, 'sticky', {
        quotaAvoidanceEnabled: false,
        startIndex
      })
      return manager.getCurrentOrNext()?.id
    })

    expect(new Set(picks).size).toBe(processCount)
    expect([...picks].sort()).toEqual([...stableAccountIds].sort())
  })
})
