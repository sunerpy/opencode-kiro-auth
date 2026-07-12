import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type Database from 'libsql'
import * as childProcess from 'node:child_process'
import { IdcAuthMethod } from '../core/auth/idc-auth-method.js'
import { AccountCache } from '../infrastructure/database/account-cache.js'
import { AccountRepository } from '../infrastructure/database/account-repository.js'
import * as oauthIdc from '../kiro/oauth-idc.js'
import { createDeterministicAccountId } from '../plugin/accounts.js'
import { kiroDb } from '../plugin/storage/sqlite.js'
import type { ManagedAccount } from '../plugin/types.js'
import * as usage from '../plugin/usage.js'

type MockToken = {
  readonly refreshToken: string
  readonly accessToken: string
  readonly expiresAt: number
  readonly clientId: string
  readonly clientSecret: string
  readonly region: 'us-east-1'
  readonly authMethod: 'idc'
}
type MockUsage = {
  readonly usedCount: number
  readonly limitCount: number
  readonly email: string
}
type AuthResultWithCallback = {
  readonly callback: () => Promise<{ readonly type: string; readonly key?: string }>
}

let currentToken: MockToken = tokenForClient('client-login')
let currentUsage: MockUsage = usageForEmail('idc-relogin@example.com')
const spies: Array<{ mockRestore: () => void }> = []

const config = {
  default_region: 'us-east-1' as const,
  idc_start_url: undefined,
  idc_region: 'us-east-1' as const,
  idc_profile_arn: undefined
}

function tokenForClient(clientId: string): MockToken {
  return {
    refreshToken: `refresh-${clientId}`,
    accessToken: `access-${clientId}`,
    expiresAt: Date.now() + 3600000,
    clientId,
    clientSecret: `secret-${clientId}`,
    region: 'us-east-1',
    authMethod: 'idc'
  }
}

function usageForEmail(email: string): MockUsage {
  return { usedCount: 7, limitCount: 100, email }
}

function rawDb(): Database.Database {
  return (kiroDb as unknown as { db: Database.Database }).db
}

function accountIds(): string[] {
  return kiroDb.getAccounts().map((row: { id: string }) => row.id)
}

function accountFor(email: string, clientId: string, profileArn: string): ManagedAccount {
  return {
    id: createDeterministicAccountId(email, 'idc', clientId, profileArn),
    email,
    authMethod: 'idc',
    region: 'us-east-1',
    clientId,
    clientSecret: `secret-${clientId}`,
    profileArn,
    refreshToken: `refresh-${clientId}`,
    accessToken: `access-${clientId}`,
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0
  }
}

function callbackFrom(result: unknown): AuthResultWithCallback {
  if (typeof result !== 'object' || result === null || !('callback' in result)) {
    throw new Error('Expected authorize() result to include callback')
  }
  const callback = result.callback
  if (typeof callback !== 'function') {
    throw new Error('Expected authorize() callback to be a function')
  }
  return { callback: callback as AuthResultWithCallback['callback'] }
}

function stubOauthAndUsage(): void {
  spies.push(
    spyOn(oauthIdc, 'authorizeKiroIDC').mockResolvedValue({
      verificationUrl: 'https://device.example/verify',
      verificationUriComplete: 'https://device.example/verify?code=USER-CODE',
      userCode: 'USER-CODE',
      deviceCode: 'device-code-1',
      clientId: 'device-client',
      clientSecret: 'device-secret',
      interval: 1,
      expiresIn: 60,
      region: 'us-east-1' as const,
      startUrl: 'https://view.awsapps.com/start'
    } as any),
    spyOn(oauthIdc, 'pollKiroIDCToken').mockImplementation(async () => currentToken as any),
    spyOn(usage, 'fetchUsageLimits').mockImplementation(async () => currentUsage as any),
    spyOn(childProcess, 'exec').mockImplementation(((_cmd: string, cb?: any) => {
      if (typeof cb === 'function') cb(null)
      return {} as any
    }) as any)
  )
}

beforeEach(() => {
  rawDb().exec('DELETE FROM accounts')
  rawDb().exec('DELETE FROM removed_accounts')
  currentToken = tokenForClient('client-login')
  currentUsage = usageForEmail('idc-relogin@example.com')
})

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
})

describe('IdcAuthMethod callback integration: tombstone clearing and cleanup safety', () => {
  test('deliberate re-login clears a tombstone before save and preserves a different profile row', async () => {
    stubOauthAndUsage()
    const email = 'idc-relogin@example.com'
    const loginProfile = 'arn:aws:codewhisperer:us-east-1:123:profile/login'
    const otherProfile = 'arn:aws:codewhisperer:us-east-1:123:profile/other'
    const loginId = createDeterministicAccountId(email, 'idc', 'client-login', loginProfile)
    const otherAccount = accountFor(email, 'client-other-profile', otherProfile)
    await kiroDb.addRemovedAccount(loginId)
    await kiroDb.batchUpsertAccounts([otherAccount])

    const repository = new AccountRepository(new AccountCache(60000))
    const accountManager = { addAccount: mock(() => {}) }
    const method = new IdcAuthMethod(config, repository, accountManager)
    const result = await callbackFrom(
      await method.authorize({ profile_arn: loginProfile })
    ).callback()

    expect(result).toEqual({ type: 'success', key: 'access-client-login' })
    expect(accountIds()).toContain(loginId)
    expect(await kiroDb.isAccountRemoved(loginId)).toBe(false)
    expect(accountIds()).toContain(otherAccount.id)
    expect(await kiroDb.isAccountRemoved(otherAccount.id)).toBe(false)
    expect(accountManager.addAccount).toHaveBeenCalledTimes(1)
  })
})
