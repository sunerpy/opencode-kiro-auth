import { describe, expect, test } from 'bun:test'
import { AuthHandler } from '../core/auth/auth-handler.js'

type FakeAccount = {
  id: string
  email: string
  usedCount: number
  limitCount: number
  isHealthy: boolean
  region: string
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

  test('all three methods are type:oauth (no type:api anywhere)', () => {
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
    expect(methods).toHaveLength(3)
    for (const m of methods) {
      expect(m.type).toBe('oauth')
    }
  })

  test('getMethods without an account manager returns [] (existing behavior)', () => {
    const handler = new AuthHandler({}, {} as any)
    expect(handler.getMethods()).toEqual([])
  })
})
