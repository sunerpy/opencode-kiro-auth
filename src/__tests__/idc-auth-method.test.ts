import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as childProcess from 'node:child_process'
import { IdcAuthMethod } from '../core/auth/idc-auth-method.js'
import * as oauthIdc from '../kiro/oauth-idc.js'
import { kiroDb } from '../plugin/storage/sqlite.js'
import * as kiroCliProfile from '../plugin/sync/kiro-cli-profile.js'
import * as usage from '../plugin/usage.js'

// IdcAuthMethod.authorize() runs the device-code flow: authorizeKiroIDC (get
// device code + verification URL), open the browser, and return a callback that
// polls the token, resolves usage/email, persists the account, and clears the
// removal tombstone. We use scoped spyOn (restored in afterEach) on every
// external edge so nothing leaks into DB-backed suites (a global mock.module of
// sqlite.js would replace the shared kiroDb singleton and break other files).

const spies: Array<{ mockRestore: () => void }> = []
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
})

function stubExec() {
  const s = spyOn(childProcess, 'exec').mockImplementation(((_cmd: string, cb?: any) => {
    if (typeof cb === 'function') cb(null)
    return {} as any
  }) as any)
  spies.push(s)
}

function baseAuthorization() {
  return {
    verificationUrl: 'https://device.example/verify',
    verificationUriComplete: 'https://device.example/verify?code=USER-CODE',
    userCode: 'USER-CODE',
    deviceCode: 'device-code-1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    interval: 1,
    expiresIn: 60,
    region: 'us-east-1' as const,
    startUrl: 'https://view.awsapps.com/start'
  }
}

function baseToken(accessToken = 'access-tok') {
  return {
    refreshToken: 'refresh-tok',
    accessToken,
    expiresAt: Date.now() + 3600000,
    email: 'builder-id@aws.amazon.com',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    region: 'us-east-1' as const,
    authMethod: 'idc' as const
  }
}

function spyAuthorize(result = baseAuthorization()) {
  const s = spyOn(oauthIdc, 'authorizeKiroIDC').mockResolvedValue(result as any)
  spies.push(s)
  return s
}

function spyPollSuccess(token = baseToken()) {
  const s = spyOn(oauthIdc, 'pollKiroIDCToken').mockResolvedValue(token as any)
  spies.push(s)
  return s
}

function spyPollError(err: Error) {
  const s = spyOn(oauthIdc, 'pollKiroIDCToken').mockRejectedValue(err)
  spies.push(s)
  return s
}

function spyUsage(responder: (auth: any) => Promise<any>) {
  const s = spyOn(usage, 'fetchUsageLimits').mockImplementation(responder as any)
  spies.push(s)
  return s
}

function spyProfile(value: string | undefined) {
  const s = spyOn(kiroCliProfile, 'readActiveProfileArnFromKiroCli').mockReturnValue(value)
  spies.push(s)
  return s
}

function spyClearRemoved() {
  const s = spyOn(kiroDb, 'clearRemovedAccount').mockResolvedValue(undefined)
  spies.push(s)
  return s
}

function repoWithSaveSpy(): { repo: any; saved: any[] } {
  const saved: any[] = []
  const repo = {
    save: async (acc: any) => {
      saved.push(acc)
    }
  }
  return { repo, saved }
}

function fakeAccountManager(): { addAccount: (a: any) => void; _calls: any[] } {
  const calls: any[] = []
  return { addAccount: (a: any) => calls.push(a), _calls: calls }
}

const baseConfig = {
  default_region: 'us-east-1',
  idc_start_url: undefined,
  idc_region: 'us-east-1',
  idc_profile_arn: undefined
}

describe('IdcAuthMethod.authorize — result shape', () => {
  test('returns the verification url, code instructions, auto method, and a callback', async () => {
    const authorize = spyAuthorize()
    stubExec()
    const method = new IdcAuthMethod(baseConfig, repoWithSaveSpy().repo, fakeAccountManager())
    const result = await method.authorize()

    expect(authorize).toHaveBeenCalledTimes(1)
    expect(result.url).toBe('https://device.example/verify?code=USER-CODE')
    expect(result.instructions).toContain('USER-CODE')
    expect(result.method).toBe('auto')
    expect(typeof result.callback).toBe('function')
  })

  test('a custom start URL routes to the portal device page and passes normalized start URL to authorizeKiroIDC', async () => {
    const authorize = spyAuthorize()
    stubExec()
    const method = new IdcAuthMethod(
      { ...baseConfig, idc_start_url: 'https://acme.awsapps.com/start' },
      repoWithSaveSpy().repo,
      fakeAccountManager()
    )
    const result = await method.authorize()
    expect(result.url).toContain('acme.awsapps.com/start/#/device?user_code=USER-CODE')
    expect(authorize.mock.calls[0]![1]).toBe('https://acme.awsapps.com/start')
  })
})

describe('IdcAuthMethod callback — success path', () => {
  test('polls token, persists the account, adds it, clears the tombstone, returns success key', async () => {
    spyAuthorize()
    const poll = spyPollSuccess()
    spyUsage(async () => ({ usedCount: 3, limitCount: 500, email: 'real@example.com' }))
    spyProfile(undefined)
    const clearRemoved = spyClearRemoved()
    stubExec()

    const { repo, saved } = repoWithSaveSpy()
    const mgr = fakeAccountManager()
    const method = new IdcAuthMethod(baseConfig, repo, mgr)
    const { callback } = (await method.authorize()) as { callback: () => Promise<any> }

    const out = await callback()

    expect(poll).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ type: 'success', key: 'access-tok' })

    expect(saved).toHaveLength(1)
    const acc = saved[0]
    expect(acc.email).toBe('real@example.com')
    expect(acc.accessToken).toBe('access-tok')
    expect(acc.refreshToken).toBe('refresh-tok')
    expect(acc.usedCount).toBe(3)
    expect(acc.limitCount).toBe(500)
    expect(acc.authMethod).toBe('idc')
    expect(acc.isHealthy).toBe(true)

    expect(mgr._calls).toHaveLength(1)
    expect(clearRemoved).toHaveBeenCalledTimes(1)
    expect(clearRemoved.mock.calls[0]![0]).toBe(acc.id)
  })

  test('when usage has no email, it falls back to decoding the JWT payload', async () => {
    const payload = Buffer.from(JSON.stringify({ email: 'jwt@example.com' })).toString('base64')
    spyAuthorize()
    spyPollSuccess(baseToken(`h.${payload}.s`))
    spyUsage(async () => ({ usedCount: 0, limitCount: 0, email: undefined }))
    spyProfile(undefined)
    spyClearRemoved()
    stubExec()

    const { repo, saved } = repoWithSaveSpy()
    const method = new IdcAuthMethod(baseConfig, repo, fakeAccountManager())
    const { callback } = (await method.authorize()) as { callback: () => Promise<any> }
    await callback()

    expect(saved[0].email).toBe('jwt@example.com')
  })
})

describe('IdcAuthMethod callback — failure paths', () => {
  test('a poll failure is wrapped in an IDC authorization error', async () => {
    spyAuthorize()
    spyPollError(new Error('device code expired'))
    spyProfile(undefined)
    stubExec()

    const method = new IdcAuthMethod(baseConfig, repoWithSaveSpy().repo, fakeAccountManager())
    const { callback } = (await method.authorize()) as { callback: () => Promise<any> }

    await expect(callback()).rejects.toThrow('IDC authorization failed: device code expired')
  })

  test('Identity Center login with no profile ARN and a usage failure demands the profile ARN', async () => {
    spyAuthorize()
    spyPollSuccess()
    spyUsage(async () => {
      throw new Error('no profile bound')
    })
    spyProfile(undefined)
    stubExec()

    const method = new IdcAuthMethod(
      { ...baseConfig, idc_start_url: 'https://acme.awsapps.com/start' },
      repoWithSaveSpy().repo,
      fakeAccountManager()
    )
    const { callback } = (await method.authorize()) as { callback: () => Promise<any> }

    await expect(callback()).rejects.toThrow('Missing profile ARN for IAM Identity Center')
  })

  test('FEATURE_NOT_SUPPORTED from usage is tolerated and login still succeeds', async () => {
    const jwt = Buffer.from(JSON.stringify({ sub: 'sub@example.com' })).toString('base64')
    spyAuthorize()
    spyPollSuccess(baseToken(`h.${jwt}.s`))
    spyUsage(async () => {
      throw new Error('FEATURE_NOT_SUPPORTED')
    })
    spyProfile(undefined)
    spyClearRemoved()
    stubExec()

    const { repo, saved } = repoWithSaveSpy()
    const method = new IdcAuthMethod(baseConfig, repo, fakeAccountManager())
    const { callback } = (await method.authorize()) as { callback: () => Promise<any> }
    const out = await callback()

    expect(out).toHaveProperty('type', 'success')
    expect(saved[0].usedCount).toBe(0)
    expect(saved[0].email).toBe('sub@example.com')
  })
})
