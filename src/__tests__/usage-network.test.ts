import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { KiroAuthDetails, ManagedAccount } from '../plugin/types.js'
import type * as UsageModule from '../plugin/usage.js'

// Sibling tests (account-tombstone / placeholder-eliminate) globally
// mock.module('../plugin/usage.js'). A query suffix busts that module-cache
// entry so THIS file exercises the REAL implementation regardless of
// test-file execution order. The specifier is built at runtime so tsc does
// not attempt to statically resolve the '?real' literal.
const usageSpecifier = '../plugin/usage.js' + '?real'
const { fetchUsageLimits, updateAccountQuota } = (await import(
  usageSpecifier
)) as typeof UsageModule

interface CapturedRequest {
  url: string
  method?: string
  headers: Record<string, string>
}

const realFetch = globalThis.fetch

function captureFetch(responder: (req: CapturedRequest, index: number) => Response): {
  fn: typeof fetch
  calls: CapturedRequest[]
} {
  const calls: CapturedRequest[] = []
  const fn = mock(async (input: any, init?: any) => {
    const headers: Record<string, string> = {}
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v
      }
    }
    const captured: CapturedRequest = {
      url: typeof input === 'string' ? input : String(input),
      method: init?.method,
      headers
    }
    const index = calls.length
    calls.push(captured)
    return responder(captured, index)
  }) as unknown as typeof fetch
  return { fn, calls }
}

function auth(overrides: Partial<KiroAuthDetails> = {}): KiroAuthDetails {
  return {
    refresh: 'r|desktop',
    access: 'access-token-123',
    expires: Date.now() + 3600000,
    authMethod: 'desktop',
    region: 'us-east-1',
    ...overrides
  }
}

function makeAccount(): ManagedAccount {
  return {
    id: 'acc-1',
    email: 'old@example.com',
    authMethod: 'desktop',
    region: 'us-east-1',
    refreshToken: 'r',
    accessToken: 'a',
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0
  }
}

describe('fetchUsageLimits (network mocked)', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('200: sums usageBreakdownList + freeTrialInfo and returns usedCount/limitCount/email', async () => {
    const payload = {
      usageBreakdownList: [
        { currentUsage: 100, usageLimit: 1000 },
        {
          currentUsage: 29,
          usageLimit: 0,
          freeTrialInfo: { currentUsage: 800, usageLimit: 9000 }
        }
      ],
      userInfo: { email: 'user@example.com' }
    }
    const { fn, calls } = captureFetch(
      () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    )
    globalThis.fetch = fn

    const result = await fetchUsageLimits(auth())

    // 100 + (29 + 800) = 929 ; 1000 + (0 + 9000) = 10000
    expect(result).toEqual({ usedCount: 929, limitCount: 10000, email: 'user@example.com' })

    // Only one attempt needed on success
    expect(calls).toHaveLength(1)
    const req = calls[0]!
    expect(req.method).toBe('GET')
    expect(req.url).toContain('https://q.us-east-1.amazonaws.com/getUsageLimits')
    expect(req.url).toContain('isEmailRequired=true')
    expect(req.url).toContain('origin=AI_EDITOR')
    expect(req.url).toContain('resourceType=AGENTIC_REQUEST')
    expect(req.headers['authorization']).toBe('Bearer access-token-123')
    expect(req.headers['x-amzn-kiro-agent-mode']).toBe('vibe')
  })

  test('includes profileArn in query when present', async () => {
    const { fn, calls } = captureFetch(
      () =>
        new Response(JSON.stringify({ usageBreakdownList: [], userInfo: { email: 'x@y.z' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    )
    globalThis.fetch = fn

    await fetchUsageLimits(auth({ profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/P' }))
    expect(calls[0]!.url).toContain('profileArn=')
  })

  test('FEATURE_NOT_SUPPORTED falls through to next attempt, succeeding on a later param set', async () => {
    const { fn, calls } = captureFetch((_req, index) => {
      if (index === 0) {
        // first attempt (AGENTIC_REQUEST) not supported
        return new Response(JSON.stringify({ __type: 'FEATURE_NOT_SUPPORTED' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response(
        JSON.stringify({
          usageBreakdownList: [{ currentUsage: 5, usageLimit: 50 }],
          userInfo: { email: 'fallback@example.com' }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })
    globalThis.fetch = fn

    const result = await fetchUsageLimits(auth())
    expect(result).toEqual({ usedCount: 5, limitCount: 50, email: 'fallback@example.com' })
    // Fell through attempt 0 -> succeeded on attempt 1
    expect(calls).toHaveLength(2)
    // attempt 1 has origin but no resourceType
    expect(calls[1]!.url).toContain('origin=AI_EDITOR')
    expect(calls[1]!.url).not.toContain('resourceType=')
  })

  test('all attempts fail: throws lastError with status + requestId + errType details', async () => {
    const { fn, calls } = captureFetch(
      () =>
        new Response('Access denied', {
          status: 403,
          headers: {
            'Content-Type': 'text/plain',
            'x-amzn-requestid': 'req-123',
            'x-amzn-errortype': 'AccessDeniedException'
          }
        })
    )
    globalThis.fetch = fn

    const err = await fetchUsageLimits(auth()).catch((e) => e)
    // 4 param-combination attempts all failed
    expect(calls).toHaveLength(4)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('403')
    expect(err.message).toContain('AccessDeniedException')
    expect(err.message).toContain('req-123')
    expect(err.message).toContain('Access denied')
  })

  test('network throw on all attempts: throws captured lastError', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('connection reset')
    }) as unknown as typeof fetch

    const err = await fetchUsageLimits(auth()).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('connection reset')
  })
})

describe('updateAccountQuota (pure)', () => {
  test('writes usedCount/limitCount/email onto account and calls accountManager.updateUsage', () => {
    const account = makeAccount()
    const updateUsage = mock((_id: string, _meta: any) => {})
    const accountManager = { updateUsage }

    updateAccountQuota(
      account,
      { usedCount: 42, limitCount: 500, email: 'new@example.com' },
      accountManager
    )

    expect(account.usedCount).toBe(42)
    expect(account.limitCount).toBe(500)
    expect(account.email).toBe('new@example.com')
    expect(updateUsage).toHaveBeenCalledTimes(1)
    expect(updateUsage).toHaveBeenCalledWith('acc-1', {
      usedCount: 42,
      limitCount: 500,
      email: 'new@example.com'
    })
  })

  test('defaults missing counts to 0 and preserves existing email when usage.email is absent', () => {
    const account = makeAccount()
    updateAccountQuota(account, {})

    expect(account.usedCount).toBe(0)
    expect(account.limitCount).toBe(0)
    // email untouched
    expect(account.email).toBe('old@example.com')
  })

  test('no accountManager: still mutates account without throwing', () => {
    const account = makeAccount()
    expect(() =>
      updateAccountQuota(account, { usedCount: 7, limitCount: 70, email: 'z@z.z' })
    ).not.toThrow()
    expect(account.usedCount).toBe(7)
    expect(account.email).toBe('z@z.z')
  })
})
