import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  configureLogging,
  debug,
  error,
  getTimestamp,
  log,
  logApiError,
  logApiRequest,
  logApiResponse,
  resetLoggingForTests,
  runLogMaintenanceNow,
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

function apiLogFiles(): string[] {
  return readdirSync(logDir()).filter((file) => file.endsWith('.ndjson'))
}

interface ApiLogRecord {
  timestamp: string
  type: 'request' | 'response'
  error?: boolean
  data: Record<string, unknown>
}

function readApiRecords(): ApiLogRecord[] {
  return apiLogFiles().flatMap((file) =>
    readFileSync(join(logDir(), file), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ApiLogRecord)
  )
}

function configure(overrides: Partial<Parameters<typeof configureLogging>[0]> = {}): void {
  configureLogging({
    log_retention_days: 7,
    log_max_total_size_mb: 512,
    log_compress_after_days: 1,
    log_segment_size_mb: 16,
    ...overrides
  })
}

beforeEach(() => {
  resetLoggingForTests()
  logHome = mkdtempSync(join(tmpdir(), 'kiro-logtest-'))
  process.env.XDG_CONFIG_HOME = logHome
  delete process.env.DEBUG
  configure()
  mkdirSync(logDir(), { recursive: true })
})

afterEach(() => {
  resetLoggingForTests()
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdg
  if (savedDebug === undefined) delete process.env.DEBUG
  else process.env.DEBUG = savedDebug
  rmSync(logHome, { recursive: true, force: true })
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

describe('logger API log segments', () => {
  test('logApiRequest appends a compact request record to an NDJSON segment', () => {
    const ts = '2024-01-01T00-00-00-000Z'
    logApiRequest({ model: 'claude', foo: 'bar' }, ts)
    const records = readApiRecords()
    expect(records).toHaveLength(1)
    expect(records[0]!.timestamp).toBe(ts)
    expect(records[0]!.type).toBe('request')
    expect(records[0]!.data.model).toBe('claude')
    expect(records[0]!.data.foo).toBe('bar')
  })

  test('request and response records share one segment instead of creating per-event files', () => {
    const ts = '2024-01-02T00-00-00-000Z'
    logApiRequest({ model: 'claude' }, ts)
    logApiResponse({ status: 200 }, ts)
    expect(apiLogFiles()).toHaveLength(1)
    expect(readdirSync(logDir()).some((file) => file.endsWith('_request.json'))).toBe(false)
    const records = readApiRecords()
    expect(records.map((record) => record.type)).toEqual(['request', 'response'])
    expect(records[1]!.data.status).toBe(200)
  })

  test('Uint8Array values in API logs are base64-encoded via the replacer', () => {
    const ts = '2024-01-03T00-00-00-000Z'
    const bytes = new Uint8Array([104, 105]) // "hi"
    logApiRequest({ payload: bytes }, ts)
    expect(readApiRecords()[0]!.data.payload).toBe(Buffer.from(bytes).toString('base64'))
  })

  test('logApiError writes correlated error records and an ERROR summary line', () => {
    const ts = '2024-01-04T00-00-00-000Z'
    logApiError({ email: 'u@example.com' }, { status: 403 }, ts)

    const records = readApiRecords()
    expect(records).toHaveLength(2)
    expect(records.every((record) => record.error === true)).toBe(true)
    expect(records.every((record) => record.timestamp === ts)).toBe(true)
    const out = readPluginLog()
    expect(out).toContain('HTTP 403 on u@example.com')
    expect(out).toContain(apiLogFiles()[0]!)
  })

  test('logApiError with no status uses "Network Error" and falls back to unknown email', () => {
    const ts = '2024-01-05T00-00-00-000Z'
    logApiError({}, {}, ts)
    const out = readPluginLog()
    expect(out).toContain('Network Error on unknown')
  })
})

describe('logger maintenance', () => {
  test('rotated API segments are gzip-compressed and the raw segment is removed', async () => {
    configure({ log_segment_size_mb: 1 })
    logApiRequest({ payload: 'x'.repeat(1_100_000) }, '2024-01-06T00-00-00-000Z')

    expect(readdirSync(logDir()).some((file) => file.endsWith('.ndjson.ready'))).toBe(true)
    await runLogMaintenanceNow()

    const files = readdirSync(logDir())
    const compressed = files.find((file) => file.endsWith('.ndjson.gz'))
    expect(compressed).toBeDefined()
    expect(files.some((file) => file.endsWith('.ndjson.ready'))).toBe(false)
    const content = gunzipSync(readFileSync(join(logDir(), compressed!))).toString('utf8')
    expect(JSON.parse(content.trim()).data.payload).toHaveLength(1_100_000)
  })

  test('expired archived logs are deleted before compression', async () => {
    const path = join(logDir(), 'api-2024-01-01-p1-old-s0000.ndjson.ready')
    writeFileSync(path, '{"old":true}\n')
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(path, old, old)
    configure({ log_retention_days: 1 })

    await runLogMaintenanceNow()

    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path.slice(0, -'.ready'.length)}.gz`)).toBe(false)
  })

  test('stale compression claims are removed when the gzip was already published', async () => {
    const ready = join(logDir(), 'api-2024-01-01-p1-crash-s0000.ndjson.ready')
    const claim = `${ready}.compressing-123-456`
    const compressed = `${ready.slice(0, -'.ready'.length)}.gz`
    writeFileSync(claim, '{"source":true}\n')
    writeFileSync(compressed, 'published')
    const stale = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(claim, stale, stale)

    await runLogMaintenanceNow()

    expect(existsSync(claim)).toBe(false)
    expect(existsSync(ready)).toBe(false)
    expect(existsSync(compressed)).toBe(true)
  })

  test('total-size cap removes the oldest archive first', async () => {
    const oldPath = join(logDir(), 'api-2024-01-01-p1-old-s0000.ndjson.gz')
    const newPath = join(logDir(), 'api-2024-01-02-p1-new-s0000.ndjson.gz')
    writeFileSync(oldPath, Buffer.alloc(9 * 1024 * 1024, 1))
    writeFileSync(newPath, Buffer.alloc(9 * 1024 * 1024, 2))
    const old = new Date(Date.now() - 60_000)
    const recent = new Date()
    utimesSync(oldPath, old, old)
    utimesSync(newPath, recent, recent)
    configure({ log_max_total_size_mb: 16 })

    await runLogMaintenanceNow()

    expect(existsSync(oldPath)).toBe(false)
    expect(existsSync(newPath)).toBe(true)
  })

  test('legacy per-request files are pruned to the hard file-count limit', async () => {
    for (let index = 0; index < 1005; index++) {
      writeFileSync(
        join(logDir(), `2024-01-01T00-00-00-${String(index).padStart(4, '0')}Z_request.json`),
        '{}'
      )
    }
    writeFileSync(join(logDir(), 'api-active.ndjson'), '{"active":true}\n')

    await runLogMaintenanceNow()

    const files = readdirSync(logDir())
    expect(files).toHaveLength(1000)
    expect(files).toContain('api-active.ndjson')
  })

  test('plugin.log rotates by size and its closed segment is compressed', async () => {
    configure({ log_segment_size_mb: 1 })
    log('x'.repeat(1_100_000))
    log('after rotation')

    expect(readdirSync(logDir()).some((file) => file.endsWith('.log.ready'))).toBe(true)
    await runLogMaintenanceNow()

    expect(readdirSync(logDir()).some((file) => file.endsWith('.log.gz'))).toBe(true)
    expect(readPluginLog()).toContain('after rotation')
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
