import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { authorizeKiroIDC, pollKiroIDCToken } from '../kiro/oauth-idc.js'

interface CapturedRequest {
  url: string
  method?: string
  headers: Record<string, string>
  body: any
}

const realFetch = globalThis.fetch
const realSetTimeout = globalThis.setTimeout

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
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined
    }
    const index = calls.length
    calls.push(captured)
    return responder(captured, index)
  }) as unknown as typeof fetch
  return { fn, calls }
}

function json(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('authorizeKiroIDC (network mocked)', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('registers client then requests device authorization, returning the device flow shape', async () => {
    const { fn, calls } = captureFetch((_req, index) => {
      if (index === 0) {
        return json({ clientId: 'reg-client', clientSecret: 'reg-secret' })
      }
      return json({
        verificationUri: 'https://device.sso/verify',
        verificationUriComplete: 'https://device.sso/verify?code=WXYZ',
        userCode: 'WXYZ',
        deviceCode: 'device-code-1',
        interval: 5,
        expiresIn: 600
      })
    })
    globalThis.fetch = fn

    const result = await authorizeKiroIDC('eu-west-1', 'https://acme.awsapps.com/start')

    expect(calls).toHaveLength(2)
    // step 1: /client/register
    const reg = calls[0]!
    expect(reg.url).toBe('https://oidc.eu-west-1.amazonaws.com/client/register')
    expect(reg.method).toBe('POST')
    expect(reg.body.clientName).toBe('Kiro IDE')
    expect(reg.body.clientType).toBe('public')
    expect(reg.body.grantTypes).toContain('urn:ietf:params:oauth:grant-type:device_code')
    expect(reg.headers['user-agent']).toBe('KiroIDE')

    // step 2: /device_authorization
    const dev = calls[1]!
    expect(dev.url).toBe('https://oidc.eu-west-1.amazonaws.com/device_authorization')
    expect(dev.body.clientId).toBe('reg-client')
    expect(dev.body.clientSecret).toBe('reg-secret')
    expect(dev.body.startUrl).toBe('https://acme.awsapps.com/start')

    expect(result).toMatchObject({
      verificationUrl: 'https://device.sso/verify',
      verificationUriComplete: 'https://device.sso/verify?code=WXYZ',
      userCode: 'WXYZ',
      deviceCode: 'device-code-1',
      clientId: 'reg-client',
      clientSecret: 'reg-secret',
      interval: 5,
      expiresIn: 600,
      region: 'eu-west-1',
      startUrl: 'https://acme.awsapps.com/start'
    })
  })

  test('defaults to Builder ID start URL and normalized region when none provided', async () => {
    const { fn, calls } = captureFetch((_req, index) => {
      if (index === 0) return json({ clientId: 'c', clientSecret: 's' })
      return json({
        verificationUri: 'u',
        verificationUriComplete: 'uc',
        userCode: 'code',
        deviceCode: 'dc'
      })
    })
    globalThis.fetch = fn

    const result = await authorizeKiroIDC()
    // normalizeRegion(undefined) -> us-east-1
    expect(calls[0]!.url).toBe('https://oidc.us-east-1.amazonaws.com/client/register')
    expect(calls[1]!.body.startUrl).toBe('https://view.awsapps.com/start')
    // interval/expiresIn defaults applied
    expect(result.interval).toBe(5)
    expect(result.expiresIn).toBe(600)
    expect(result.region).toBe('us-east-1')
  })

  test('throws when client registration fails (non-200)', async () => {
    const { fn } = captureFetch(() => new Response('nope', { status: 400 }))
    globalThis.fetch = fn
    const err = await authorizeKiroIDC('us-east-1').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('Client registration failed: 400')
  })

  test('throws when registration response lacks clientId/clientSecret', async () => {
    const { fn } = captureFetch(() => json({ clientId: 'only-id' }))
    globalThis.fetch = fn
    const err = await authorizeKiroIDC('us-east-1').catch((e) => e)
    expect(err.message).toContain('missing clientId or clientSecret')
  })

  test('throws when device authorization fails (non-200)', async () => {
    const { fn } = captureFetch((_req, index) => {
      if (index === 0) return json({ clientId: 'c', clientSecret: 's' })
      return new Response('device error', { status: 500 })
    })
    globalThis.fetch = fn
    const err = await authorizeKiroIDC('us-east-1').catch((e) => e)
    expect(err.message).toContain('Device authorization failed: 500')
  })

  test('throws when device authorization response is missing required fields', async () => {
    const { fn } = captureFetch((_req, index) => {
      if (index === 0) return json({ clientId: 'c', clientSecret: 's' })
      return json({ userCode: 'code' }) // missing deviceCode/verificationUri...
    })
    globalThis.fetch = fn
    const err = await authorizeKiroIDC('us-east-1').catch((e) => e)
    expect(err.message).toContain('missing required fields')
  })
})

describe('pollKiroIDCToken (network + timers mocked)', () => {
  beforeEach(() => {
    // Make setTimeout resolve immediately: NO real delay in tests.
    globalThis.setTimeout = ((cb: (...args: any[]) => void) => {
      cb()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    globalThis.setTimeout = realSetTimeout
  })

  test('validates required parameters before polling', async () => {
    const err = await pollKiroIDCToken('', 's', 'd', 5, 600, 'us-east-1').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('Missing required parameters')
  })

  test('polls token endpoint: authorization_pending then success returns token result', async () => {
    const { fn, calls } = captureFetch((_req, index) => {
      if (index === 0) return json({ error: 'authorization_pending' })
      return json({
        access_token: 'idc-access',
        refresh_token: 'idc-refresh',
        expires_in: 1800
      })
    })
    globalThis.fetch = fn

    const result = await pollKiroIDCToken('client', 'secret', 'device', 5, 600, 'us-east-1')

    // Polled twice: pending, then success
    expect(calls).toHaveLength(2)
    const req = calls[0]!
    expect(req.url).toBe('https://oidc.us-east-1.amazonaws.com/token')
    expect(req.method).toBe('POST')
    expect(req.body.clientId).toBe('client')
    expect(req.body.clientSecret).toBe('secret')
    expect(req.body.deviceCode).toBe('device')
    expect(req.body.grantType).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(req.headers['user-agent']).toBe('KiroIDE')

    expect(result).toMatchObject({
      refreshToken: 'idc-refresh',
      accessToken: 'idc-access',
      email: 'builder-id@aws.amazon.com',
      clientId: 'client',
      clientSecret: 'secret',
      region: 'us-east-1',
      authMethod: 'idc'
    })
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 1700 * 1000)
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 1800 * 1000)
  })

  test('slow_down increases interval and keeps polling until success', async () => {
    const { fn, calls } = captureFetch((_req, index) => {
      if (index === 0) return json({ error: 'slow_down' })
      if (index === 1) return json({ error: 'authorization_pending' })
      return json({ accessToken: 'a', refreshToken: 'r' })
    })
    globalThis.fetch = fn

    const result = await pollKiroIDCToken('client', 'secret', 'device', 5, 600, 'us-east-1')
    expect(calls).toHaveLength(3)
    expect(result.accessToken).toBe('a')
    expect(result.refreshToken).toBe('r')
  })

  test('expired_token error throws immediately', async () => {
    const { fn } = captureFetch(() => json({ error: 'expired_token' }))
    globalThis.fetch = fn
    const err = await pollKiroIDCToken('client', 'secret', 'device', 5, 600, 'us-east-1').catch(
      (e) => e
    )
    expect(err.message).toContain('Device code has expired')
  })

  test('access_denied error throws immediately', async () => {
    const { fn } = captureFetch(() => json({ error: 'access_denied' }))
    globalThis.fetch = fn
    const err = await pollKiroIDCToken('client', 'secret', 'device', 5, 600, 'us-east-1').catch(
      (e) => e
    )
    expect(err.message).toContain('Authorization was denied')
  })

  test('unknown error type throws with description', async () => {
    const { fn } = captureFetch(() =>
      json({ error: 'invalid_client', error_description: 'bad creds' })
    )
    globalThis.fetch = fn
    const err = await pollKiroIDCToken('client', 'secret', 'device', 5, 600, 'us-east-1').catch(
      (e) => e
    )
    expect(err.message).toContain('invalid_client')
    expect(err.message).toContain('bad creds')
  })

  test('times out when maxAttempts is exhausted with only pending responses', async () => {
    const { fn, calls } = captureFetch(() => json({ error: 'authorization_pending' }))
    globalThis.fetch = fn

    // expiresIn/interval => maxAttempts = 10/5 = 2
    const err = await pollKiroIDCToken('client', 'secret', 'device', 5, 10, 'us-east-1').catch(
      (e) => e
    )
    expect(calls).toHaveLength(2)
    expect(err.message).toContain('timed out')
  })
})
