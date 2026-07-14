import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  debug,
  error,
  getTimestamp,
  log,
  logApiError,
  logApiRequest,
  logApiResponse,
  warn
} from '../plugin/logger.js'

// logger.ts computes its log dir from XDG_CONFIG_HOME at call time (not module
// eval), so we can point it at a throwaway dir per test and read the real files
// it writes. This exercises the real file sink, not a mock.

let logHome: string
const savedXdg = process.env.XDG_CONFIG_HOME
const savedDebug = process.env.DEBUG

function logDir(): string {
  return join(logHome, 'opencode', 'kiro-auth-plugin', 'logs')
}

function readPluginLog(): string {
  const p = join(logDir(), 'plugin.log')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

beforeEach(() => {
  logHome = mkdtempSync(join(tmpdir(), 'kiro-logtest-'))
  process.env.XDG_CONFIG_HOME = logHome
  delete process.env.DEBUG
})

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdg
  if (savedDebug === undefined) delete process.env.DEBUG
  else process.env.DEBUG = savedDebug
})

describe('logger level functions write labeled lines', () => {
  test('log() writes an INFO line with the message', () => {
    log('hello info')
    const out = readPluginLog()
    expect(out).toContain('INFO: hello info')
  })

  test('warn() writes a WARN line', () => {
    warn('careful now')
    expect(readPluginLog()).toContain('WARN: careful now')
  })

  test('error() writes an ERROR line', () => {
    error('it broke')
    expect(readPluginLog()).toContain('ERROR: it broke')
  })

  test('each line is ISO-timestamp prefixed', () => {
    log('stamped')
    const out = readPluginLog()
    // Line format: [<ISO timestamp>] LEVEL: message
    expect(out).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] INFO: stamped/m)
  })
})

describe('logger debug gating on DEBUG env', () => {
  test('debug() writes nothing when DEBUG is unset', () => {
    debug('should be suppressed')
    expect(readPluginLog()).not.toContain('should be suppressed')
  })

  test('debug() writes a DEBUG line when DEBUG is set', () => {
    process.env.DEBUG = '1'
    debug('now visible')
    expect(readPluginLog()).toContain('DEBUG: now visible')
  })
})

describe('logger argument formatting branches', () => {
  test('Error arg is rendered with name, message and stack', () => {
    log('with error', new Error('boom'))
    const out = readPluginLog()
    expect(out).toContain('Error: boom')
    // Stack trace is appended (multi-line).
    expect(out).toContain('at ')
  })

  test('object arg is JSON-serialized', () => {
    log('with object', { a: 1, b: 'two' })
    expect(readPluginLog()).toContain('{"a":1,"b":"two"}')
  })

  test('unserializable (circular) object falls back to placeholder', () => {
    const circular: any = {}
    circular.self = circular
    log('with circular', circular)
    expect(readPluginLog()).toContain('[Unserializable object]')
  })

  test('primitive args are stringified', () => {
    log('with primitives', 42, true)
    const out = readPluginLog()
    expect(out).toContain('42')
    expect(out).toContain('true')
  })
})

describe('logger API log files', () => {
  test('logApiRequest writes a <ts>_request.json file with the data', () => {
    const ts = '2024-01-01T00-00-00-000Z'
    logApiRequest({ model: 'claude', foo: 'bar' }, ts)
    const path = join(logDir(), `${ts}_request.json`)
    expect(existsSync(path)).toBe(true)
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    expect(parsed.model).toBe('claude')
    expect(parsed.foo).toBe('bar')
  })

  test('logApiResponse writes a <ts>_response.json file', () => {
    const ts = '2024-01-02T00-00-00-000Z'
    logApiResponse({ status: 200 }, ts)
    const path = join(logDir(), `${ts}_response.json`)
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).status).toBe(200)
  })

  test('Uint8Array values in API logs are base64-encoded via the replacer', () => {
    const ts = '2024-01-03T00-00-00-000Z'
    const bytes = new Uint8Array([104, 105]) // "hi"
    logApiRequest({ payload: bytes }, ts)
    const parsed = JSON.parse(readFileSync(join(logDir(), `${ts}_request.json`), 'utf8'))
    expect(parsed.payload).toBe(Buffer.from(bytes).toString('base64'))
  })

  test('logApiError writes error_-prefixed files and an ERROR summary line with HTTP status', () => {
    const ts = '2024-01-04T00-00-00-000Z'
    logApiError({ email: 'u@example.com' }, { status: 403 }, ts)

    const files = readdirSync(logDir())
    expect(files).toContain(`error_${ts}_request.json`)
    expect(files).toContain(`error_${ts}_response.json`)

    const out = readPluginLog()
    expect(out).toContain('HTTP 403 on u@example.com')
  })

  test('logApiError with no status uses "Network Error" and falls back to unknown email', () => {
    const ts = '2024-01-05T00-00-00-000Z'
    logApiError({}, {}, ts)
    const out = readPluginLog()
    expect(out).toContain('Network Error on unknown')
  })
})

describe('getTimestamp', () => {
  test('returns a filesystem-safe timestamp with colons and dots replaced by dashes', () => {
    const ts = getTimestamp()
    expect(ts).not.toContain(':')
    expect(ts).not.toContain('.')
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
