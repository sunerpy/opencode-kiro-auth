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

  test('remove method exists with select options for account + Cancel; authorize removes and returns failed', async () => {
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
    const remove = methods.find((m) => m.label.includes('Remove account'))
    expect(remove).toBeDefined()
    expect(remove!.label).toContain('Remove account')
    expect(remove!.type).toBe('api')

    const prompt = remove!.prompts![0]!
    expect(prompt.type).toBe('select')
    const select = prompt as { type: 'select'; options: Array<{ label: string; value: string }> }
    const values = select.options.map((o) => o.value)
    expect(values).toContain('x')
    expect(values).toContain('__cancel__')
    const accountOption = select.options.find((o) => o.value === 'x')
    expect(accountOption!.label).toContain('a@b.com')

    const authorize = (remove as { authorize: (i?: Record<string, string>) => Promise<any> })
      .authorize
    const result = await authorize({ account_id: 'x' })
    expect(removed).toHaveLength(1)
    expect(removed[0]).toBe(acc)
    expect(result).toEqual({ type: 'failed' })
  })

  test('authorize with __cancel__ does not remove and returns failed', async () => {
    const acc: FakeAccount = {
      id: 'x',
      email: 'a@b.com',
      usedCount: 1,
      limitCount: 10,
      isHealthy: true,
      region: 'us-east-1'
    }
    const { handler, removed } = makeHandler([acc])
    const methods = handler.getMethods()
    const remove = methods.find((m) => m.label.includes('Remove account'))!
    const authorize = (remove as { authorize: (i?: Record<string, string>) => Promise<any> })
      .authorize
    const result = await authorize({ account_id: '__cancel__' })
    expect(removed).toHaveLength(0)
    expect(result).toEqual({ type: 'failed' })
  })

  test('getMethods without an account manager returns [] (existing behavior)', () => {
    const handler = new AuthHandler({}, {} as any)
    expect(handler.getMethods()).toEqual([])
  })
})
