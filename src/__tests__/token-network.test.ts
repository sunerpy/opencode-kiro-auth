import { afterEach, describe, expect, mock, test } from 'bun:test'
import { encodeRefreshToken } from '../kiro/auth.js'
import { KiroTokenRefreshError } from '../plugin/errors.js'
import { refreshAccessToken } from '../plugin/token.js'
import type { KiroAuthDetails } from '../plugin/types.js'

interface CapturedRequest {
  url: string
  method?: string
  headers: Record<string, string>
  body: any
}

const realFetch = globalThis.fetch

function captureFetch(responder: (req: CapturedRequest) => Response): {
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
    calls.push(captured)
    return responder(captured)
  }) as unknown as typeof fetch
  return { fn, calls }
}

function idcAuth(overrides: Partial<KiroAuthDetails> = {}): KiroAuthDetails {
  const refresh = encodeRefreshToken({
    refreshToken: 'idc-refresh-token',
    clientId: 'client-abc',
    clientSecret: 'secret-xyz',
    authMethod: 'idc'
  })
  return {
    refresh,
    access: 'old-access',
    expires: Date.now(),
    authMethod: 'idc',
    region: 'us-east-1',
    oidcRegion: 'eu-west-1',
    ...overrides
  }
}

function desktopAuth(overrides: Partial<KiroAuthDetails> = {}): KiroAuthDetails {
  const refresh = encodeRefreshToken({
    refreshToken: 'desktop-refresh-token',
    authMethod: 'desktop'
  })
  return {
    refresh,
    access: 'old-access',
    expires: Date.now(),
    authMethod: 'desktop',
    region: 'us-west-2',
    ...overrides
  }
}

describe('refreshAccessToken (network mocked)', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('IDC refresh: POSTs to oidc.{oidcRegion}.amazonaws.com/token with refresh_token grant + KiroIDE UA', async () => {
    const { fn, calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            access_token: 'new-idc-access',
            refresh_token: 'rotated-refresh',
            expires_in: 1800
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    )
    globalThis.fetch = fn

    const result = await refreshAccessToken(idcAuth())

    expect(calls).toHaveLength(1)
    const req = calls[0]!
    // oidcRegion (eu-west-1), NOT region (us-east-1)
    expect(req.url).toBe('https://oidc.eu-west-1.amazonaws.com/token')
    expect(req.method).toBe('POST')
    expect(req.body.grantType).toBe('refresh_token')
    expect(req.body.refreshToken).toBe('idc-refresh-token')
    expect(req.body.clientId).toBe('client-abc')
    expect(req.body.clientSecret).toBe('secret-xyz')
    expect(req.headers['user-agent']).toContain('KiroIDE')
    expect(req.headers['x-amzn-kiro-agent-mode']).toBe('vibe')
    expect(req.headers['content-type']).toBe('application/json')

    expect(result.access).toBe('new-idc-access')
    expect(result.authMethod).toBe('idc')
    // expires computed as now + expires_in*1000
    expect(result.expires).toBeGreaterThan(Date.now() + 1700 * 1000)
    expect(result.expires).toBeLessThanOrEqual(Date.now() + 1800 * 1000)
    // rotated refresh re-encoded with client creds + idc marker
    expect(result.refresh).toContain('rotated-refresh')
    expect(result.refresh).toContain('|idc')
  })

  test('IDC refresh falls back to region when oidcRegion is absent', async () => {
    const { fn, calls } = captureFetch(
      () =>
        new Response(JSON.stringify({ accessToken: 'a', refreshToken: 'r' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    )
    globalThis.fetch = fn

    await refreshAccessToken(idcAuth({ oidcRegion: undefined, region: 'ap-southeast-1' }))
    expect(calls[0]!.url).toBe('https://oidc.ap-southeast-1.amazonaws.com/token')
  })

  test('IDC refresh: missing clientId/clientSecret throws MISSING_CREDENTIALS before any fetch', async () => {
    const { fn, calls } = captureFetch(() => new Response('{}', { status: 200 }))
    globalThis.fetch = fn

    // desktop-encoded refresh has no client creds; force authMethod idc
    const auth = desktopAuth({ authMethod: 'idc' })
    await expect(refreshAccessToken(auth)).rejects.toMatchObject({
      name: 'KiroTokenRefreshError',
      code: 'MISSING_CREDENTIALS'
    })
    expect(calls).toHaveLength(0)
  })

  test('Desktop refresh: POSTs to prod.{region}.auth.desktop.kiro.dev/refreshToken with bare refreshToken body', async () => {
    const { fn, calls } = captureFetch(
      () =>
        new Response(JSON.stringify({ accessToken: 'new-desktop-access', expiresIn: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    )
    globalThis.fetch = fn

    const result = await refreshAccessToken(desktopAuth())

    expect(calls).toHaveLength(1)
    const req = calls[0]!
    expect(req.url).toBe('https://prod.us-west-2.auth.desktop.kiro.dev/refreshToken')
    expect(req.method).toBe('POST')
    expect(req.body).toEqual({ refreshToken: 'desktop-refresh-token' })
    // desktop UA still contains KiroIDE
    expect(req.headers['user-agent']).toContain('KiroIDE')

    expect(result.access).toBe('new-desktop-access')
    expect(result.authMethod).toBe('desktop')
    // no rotated refresh -> reuses original refreshToken, desktop marker
    expect(result.refresh).toBe('desktop-refresh-token|desktop')
  })

  test('non-200 response throws KiroTokenRefreshError carrying the server __type code', async () => {
    const { fn } = captureFetch(
      () =>
        new Response(
          JSON.stringify({ message: 'Invalid grant', __type: 'InvalidGrantException' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
    )
    globalThis.fetch = fn

    const err = await refreshAccessToken(idcAuth()).catch((e) => e)
    expect(err).toBeInstanceOf(KiroTokenRefreshError)
    expect(err.code).toBe('InvalidGrantException')
    expect(err.message).toContain('Invalid grant')
  })

  test('non-200 with non-JSON body throws HTTP_<status> code', async () => {
    const { fn } = captureFetch(() => new Response('gateway boom', { status: 502 }))
    globalThis.fetch = fn

    const err = await refreshAccessToken(desktopAuth()).catch((e) => e)
    expect(err).toBeInstanceOf(KiroTokenRefreshError)
    expect(err.code).toBe('HTTP_502')
    expect(err.message).toContain('gateway boom')
  })

  test('200 but no access token throws INVALID_RESPONSE', async () => {
    const { fn } = captureFetch(
      () =>
        new Response(JSON.stringify({ refresh_token: 'r' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    )
    globalThis.fetch = fn

    const err = await refreshAccessToken(idcAuth()).catch((e) => e)
    expect(err).toBeInstanceOf(KiroTokenRefreshError)
    expect(err.code).toBe('INVALID_RESPONSE')
  })

  test('network throw is wrapped as NETWORK_ERROR preserving originalError', async () => {
    const boom = new Error('socket hang up')
    globalThis.fetch = mock(async () => {
      throw boom
    }) as unknown as typeof fetch

    const err = await refreshAccessToken(desktopAuth()).catch((e) => e)
    expect(err).toBeInstanceOf(KiroTokenRefreshError)
    expect(err.code).toBe('NETWORK_ERROR')
    expect(err.originalError).toBe(boom)
  })
})
