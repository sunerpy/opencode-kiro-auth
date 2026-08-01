import { afterEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { RefreshAllSummary } from '../core/account/account-refresh-service.js'
import { AuthHandler } from '../core/auth/auth-handler.js'
import { PLUGIN_VERSION } from '../version.js'

type FakeAccount = {
  id: string
  email: string
  usedCount: number
  limitCount: number
  isHealthy: boolean
  region: string
  accessToken?: string
}

type MenuAuthorizeResult = {
  callback: () => Promise<{ type: 'failed' } | { type: 'success'; key: string }>
}

function makeHandler(accounts: FakeAccount[]) {
  const removed: FakeAccount[] = []
  const accountManager = {
    getAccounts: () => accounts,
    removeAccount: (a: FakeAccount) => {
      removed.push(a)
    }
  }
  const config = {}
  const repository = {} as any
  const handler = new AuthHandler(config, repository)
  handler.setAccountManager(accountManager)
  return { handler, removed }
}

const realStdin = process.stdin
const realStdout = process.stdout

class FakeStdin extends EventEmitter {
  isTTY = true
  isRaw = false

  setRawMode(value: boolean): this {
    this.isRaw = value
    return this
  }

  resume(): this {
    return this
  }

  pause(): this {
    return this
  }
}

class FakeStdout {
  isTTY = true
  written: string[] = []

  write(value: string | Uint8Array): boolean {
    this.written.push(String(value))
    return true
  }
}

let fakeStdin: FakeStdin | undefined
let fakeStdout: FakeStdout | undefined

function installFakeTty(): void {
  fakeStdin = new FakeStdin()
  fakeStdout = new FakeStdout()
  Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true })
  Object.defineProperty(process, 'stdout', { value: fakeStdout, configurable: true })
}

function feedEnterTwice(): void {
  let remaining = 2
  const pump = (): void => {
    if (remaining === 0) return
    if (fakeStdin && fakeStdin.listenerCount('data') > 0) {
      remaining--
      fakeStdin.emit('data', Buffer.from('\r'))
    }
    setTimeout(pump, 0)
  }
  setTimeout(pump, 0)
}

function makeSummary(account: FakeAccount, beforeUsed: number): RefreshAllSummary {
  return {
    startedAt: 1,
    completedAt: 2,
    totalAccounts: 1,
    tokenRenewed: 0,
    tokenSkipped: 1,
    usageUpdated: 1,
    failed: 0,
    timedOut: false,
    lockAcquired: true,
    proceededWithoutLock: false,
    accounts: [
      {
        accountId: account.id,
        email: account.email,
        before: { usedCount: beforeUsed, limitCount: account.limitCount },
        after: { usedCount: account.usedCount, limitCount: account.limitCount },
        tokenStatus: 'not_needed',
        usageStatus: 'updated'
      }
    ]
  }
}

afterEach(() => {
  Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true })
  Object.defineProperty(process, 'stdout', { value: realStdout, configurable: true })
  fakeStdin = undefined
  fakeStdout = undefined
})

describe('auth account management', () => {
  test('first login label includes existing accounts + usage summary', () => {
    const { handler } = makeHandler([
      {
        id: 'x',
        email: 'a@b.com',
        usedCount: 929,
        limitCount: 10000,
        isHealthy: true,
        region: 'us-east-1'
      }
    ])
    const methods = handler.getMethods()
    const first = methods[0]!
    expect(first.label).toContain('Add account')
    expect(first.label).toContain(`plugin v${PLUGIN_VERSION}`)
    expect(first.label).toContain('a@b.com')
    expect(first.label).toContain('929/10000')
    expect(first.label).toContain('9%')
  })

  test('remove method is type:oauth and, in a non-TTY env, its authorize returns method:auto with a failed callback and no key prompt', async () => {
    const acc: FakeAccount = {
      id: 'x',
      email: 'a@b.com',
      usedCount: 929,
      limitCount: 10000,
      isHealthy: true,
      region: 'us-east-1'
    }
    const { handler, removed } = makeHandler([acc])
    const methods = handler.getMethods()
    const remove = methods.find((m) => m.label.includes('remove') || m.label.includes('Manage'))
    expect(remove).toBeDefined()
    expect(remove!.type).toBe('oauth')
    expect((remove as { prompts?: unknown }).prompts).toBeUndefined()

    const authorize = (remove as { authorize: (i?: Record<string, string>) => Promise<any> })
      .authorize
    const result = await authorize()
    expect(result.url).toBe('')
    expect(result.method).toBe('auto')
    expect(typeof result.callback).toBe('function')
    expect(await result.callback()).toEqual({ type: 'failed' })
    expect(removed).toHaveLength(0)
  })

  test('remove method with zero accounts returns method:auto/failed without prompting', async () => {
    const { handler } = makeHandler([])
    const methods = handler.getMethods()
    const remove = methods.find((m) => m.label.includes('remove') || m.label.includes('Manage'))!
    const authorize = (remove as { authorize: (i?: Record<string, string>) => Promise<any> })
      .authorize
    const result = await authorize()
    expect(result.method).toBe('auto')
    expect(result.url).toBe('')
    expect(await result.callback()).toEqual({ type: 'failed' })
  })

  test('all four methods are type:oauth (no type:api anywhere)', () => {
    const { handler } = makeHandler([
      {
        id: 'x',
        email: 'a@b.com',
        usedCount: 1,
        limitCount: 10,
        isHealthy: true,
        region: 'us-east-1'
      }
    ])
    const methods = handler.getMethods()
    expect(methods).toHaveLength(4)
    for (const m of methods) {
      expect(m.type).toBe('oauth')
    }
  })

  test('top-level refresh-all method refreshes usage, prints before/after, and ends successfully', async () => {
    installFakeTty()
    const account: FakeAccount = {
      id: 'refresh-all',
      email: 'refresh-all@example.com',
      usedCount: 10,
      limitCount: 100,
      isHealthy: true,
      region: 'us-east-1',
      accessToken: 'token-refresh-all'
    }
    const { handler } = makeHandler([account])
    const refreshAll = mock(async () => {
      const beforeUsed = account.usedCount
      account.usedCount = 40
      return makeSummary(account, beforeUsed)
    })
    handler.setAccountRefreshService({ refreshAll, refreshAccount: refreshAll })
    const method = handler
      .getMethods()
      .find((candidate) => candidate.label === 'Refresh all accounts · tokens + usage')!

    const authorize = (method as { authorize: () => Promise<MenuAuthorizeResult> }).authorize
    const result = await authorize()

    expect(method.type).toBe('oauth')
    expect(refreshAll).toHaveBeenCalledTimes(1)
    expect(fakeStdout?.written.join('')).toContain('10/100 → 40/100')
    expect(await result.callback()).toEqual({ type: 'success', key: 'token-refresh-all' })
  })

  test('per-account refresh action re-renders the account line with current usage', async () => {
    installFakeTty()
    const account: FakeAccount = {
      id: 'refresh-one',
      email: 'refresh-one@example.com',
      usedCount: 11,
      limitCount: 100,
      isHealthy: true,
      region: 'us-east-1',
      accessToken: 'token-refresh-one'
    }
    const { handler } = makeHandler([account])
    const refreshAccount = mock(async () => {
      const beforeUsed = account.usedCount
      account.usedCount = 77
      return makeSummary(account, beforeUsed)
    })
    handler.setAccountRefreshService({ refreshAll: refreshAccount, refreshAccount })
    const manage = handler.getMethods().find((candidate) => candidate.label === 'Manage accounts')!
    feedEnterTwice()

    const authorize = (manage as { authorize: () => Promise<MenuAuthorizeResult> }).authorize
    const result = await authorize()

    expect(refreshAccount).toHaveBeenCalledWith(account.id, { force: true })
    expect(fakeStdout?.written.join('')).toContain(
      'refresh-one@example.com — 77/100 (us-east-1, healthy)'
    )
    expect(await result.callback()).toEqual({ type: 'success', key: 'token-refresh-one' })
  })

  test('getMethods without an account manager returns [] (existing behavior)', () => {
    const handler = new AuthHandler({}, {} as any)
    expect(handler.getMethods()).toEqual([])
  })

  test('post-delete: with a healthy remaining account, ends with success keyed on its accessToken', async () => {
    const { handler } = makeHandler([
      {
        id: 'x',
        email: 'a@b.com',
        usedCount: 1,
        limitCount: 10,
        isHealthy: true,
        region: 'us-east-1',
        accessToken: 'tok-abc'
      }
    ])
    const result = (handler as any).endWithRemainingCredentialOrFailed(
      'Account deleted: gone@b.com.'
    )
    expect(result.method).toBe('auto')
    expect(result.url).toBe('')
    expect(result.instructions).toContain('a@b.com')
    expect(await result.callback()).toEqual({ type: 'success', key: 'tok-abc' })
  })

  test('post-delete: prefers a healthy account over an unhealthy one with a token', async () => {
    const { handler } = makeHandler([
      {
        id: 'u',
        email: 'unhealthy@b.com',
        usedCount: 1,
        limitCount: 10,
        isHealthy: false,
        region: 'us-east-1',
        accessToken: 'tok-unhealthy'
      },
      {
        id: 'h',
        email: 'healthy@b.com',
        usedCount: 1,
        limitCount: 10,
        isHealthy: true,
        region: 'us-east-1',
        accessToken: 'tok-healthy'
      }
    ])
    const result = (handler as any).endWithRemainingCredentialOrFailed(
      'Account deleted: gone@b.com.'
    )
    expect(await result.callback()).toEqual({ type: 'success', key: 'tok-healthy' })
  })

  test('post-delete: falls back to any account with a token when none are healthy', async () => {
    const { handler } = makeHandler([
      {
        id: 'u',
        email: 'unhealthy@b.com',
        usedCount: 1,
        limitCount: 10,
        isHealthy: false,
        region: 'us-east-1',
        accessToken: 'tok-only'
      }
    ])
    const result = (handler as any).endWithRemainingCredentialOrFailed(
      'Account deleted: gone@b.com.'
    )
    expect(await result.callback()).toEqual({ type: 'success', key: 'tok-only' })
  })

  test('post-delete: with no accounts remaining, ends with a failed callback', async () => {
    const { handler } = makeHandler([])
    const result = (handler as any).endWithRemainingCredentialOrFailed(
      'Account deleted: gone@b.com.'
    )
    expect(result.method).toBe('auto')
    expect(result.url).toBe('')
    expect(result.instructions).toContain('No accounts remain')
    expect(await result.callback()).toEqual({ type: 'failed' })
  })

  test('post-delete: skips accounts without a usable accessToken', async () => {
    const { handler } = makeHandler([
      {
        id: 'x',
        email: 'a@b.com',
        usedCount: 1,
        limitCount: 10,
        isHealthy: true,
        region: 'us-east-1'
      }
    ])
    const result = (handler as any).endWithRemainingCredentialOrFailed(
      'Account deleted: gone@b.com.'
    )
    expect(await result.callback()).toEqual({ type: 'failed' })
  })
})
