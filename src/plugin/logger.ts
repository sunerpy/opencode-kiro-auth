import { Buffer } from 'node:buffer'
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  configureLogMaintenance,
  ensureLogsDir,
  markLogReady,
  resetLogMaintenanceForTests,
  runLogMaintenance,
  scheduleLogMaintenance,
  shouldRotateLog,
  type LogMaintenanceOptions
} from './log-maintenance.js'
import { redactReasoningForLog } from './log-redaction.js'

const MEBIBYTE = 1024 * 1024
const PROCESS_INSTANCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export interface LoggingOptions extends LogMaintenanceOptions {
  log_segment_size_mb: number
}

interface ApiSegment {
  date: string
  directory: string
  path: string
  size: number
}

const DEFAULT_OPTIONS: LoggingOptions = {
  log_retention_days: 7,
  log_max_total_size_mb: 512,
  log_compress_after_days: 1,
  log_segment_size_mb: 16
}

let segmentSizeBytes = DEFAULT_OPTIONS.log_segment_size_mb * MEBIBYTE
let apiSegment: ApiSegment | undefined
let apiSequence = 0
let pluginLogSequence = 0

function boundedNumber(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}

const binaryToBase64Replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return value
}

function rotatePluginLog(path: string): void {
  const dir = ensureLogsDir()
  const rotated = join(
    dir,
    `plugin-${getTimestamp()}-p${process.pid}-${PROCESS_INSTANCE}-${pluginLogSequence++}.log.ready`
  )

  try {
    renameSync(path, rotated)
  } catch {}
  scheduleLogMaintenance()
}

const writeToFile = (level: string, message: string, ...args: unknown[]) => {
  try {
    const dir = ensureLogsDir()
    const path = join(dir, 'plugin.log')
    const timestamp = new Date().toISOString()
    const content = `[${timestamp}] ${level}: ${message} ${args
      .map((a) => {
        if (a instanceof Error) {
          return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`
        }
        if (typeof a === 'object') {
          try {
            // §6.8: redact at the sink, so no caller can leak a signature by logging
            // a prepared request or a whole conversationState for debugging.
            return JSON.stringify(redactReasoningForLog(a))
          } catch {
            return '[Unserializable object]'
          }
        }
        return String(a)
      })
      .join(' ')}\n`
    const contentBytes = Buffer.byteLength(content)
    if (shouldRotateLog(path, segmentSizeBytes, contentBytes)) rotatePluginLog(path)
    appendFileSync(path, content)
    scheduleLogMaintenance()
    if (contentBytes >= segmentSizeBytes) rotatePluginLog(path)
  } catch {}
}

function currentDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function segmentPath(directory: string, date: string, sequence: number): string {
  return join(
    directory,
    `api-${date}-p${process.pid}-${PROCESS_INSTANCE}-s${String(sequence).padStart(4, '0')}.ndjson`
  )
}

function openApiSegment(): ApiSegment {
  const directory = ensureLogsDir()
  const date = currentDate()

  if (
    apiSegment &&
    apiSegment.directory === directory &&
    apiSegment.date === date &&
    existsSync(apiSegment.path)
  ) {
    return apiSegment
  }

  if (apiSegment?.path && existsSync(apiSegment.path)) markLogReady(apiSegment.path)
  const sequence = apiSequence++
  const path = segmentPath(directory, date, sequence)
  let size = 0
  try {
    size = statSync(path).size
  } catch {}

  apiSegment = { date, directory, path, size }
  return apiSegment
}

function rotateApiSegment(segment: ApiSegment): ApiSegment {
  markLogReady(segment.path)
  apiSegment = undefined
  return openApiSegment()
}

const writeApiLog = (
  type: 'request' | 'response',
  data: unknown,
  timestamp: string,
  isError = false
): string | undefined => {
  try {
    let segment = openApiSegment()
    const content = `${JSON.stringify(
      {
        timestamp,
        type,
        ...(isError ? { error: true } : {}),
        data: redactReasoningForLog(data)
      },
      binaryToBase64Replacer
    )}\n`
    const contentBytes = Buffer.byteLength(content)

    if (segment.size > 0 && segment.size + contentBytes > segmentSizeBytes) {
      segment = rotateApiSegment(segment)
    }

    appendFileSync(segment.path, content)
    segment.size += contentBytes
    scheduleLogMaintenance()

    if (segment.size >= segmentSizeBytes) rotateApiSegment(segment)
    return basename(segment.path)
  } catch {}
  return undefined
}

export function log(message: string, ...args: unknown[]): void {
  writeToFile('INFO', message, ...args)
}

export function error(message: string, ...args: unknown[]): void {
  writeToFile('ERROR', message, ...args)
}

export function warn(message: string, ...args: unknown[]): void {
  writeToFile('WARN', message, ...args)
}

export function debug(message: string, ...args: unknown[]): void {
  if (process.env.DEBUG) {
    writeToFile('DEBUG', message, ...args)
  }
}

export function logApiRequest(data: unknown, timestamp: string): void {
  writeApiLog('request', data, timestamp)
}

export function logApiResponse(data: unknown, timestamp: string): void {
  writeApiLog('response', data, timestamp)
}

export function logApiError(
  requestData: Record<string, unknown>,
  responseData: Record<string, unknown>,
  timestamp: string
): void {
  const filename = writeApiLog('request', requestData, timestamp, true)
  writeApiLog('response', responseData, timestamp, true)
  const errorType = responseData.status ? `HTTP ${responseData.status}` : 'Network Error'
  const accountAlias =
    typeof requestData.accountAlias === 'string' ? requestData.accountAlias : 'unknown'
  error(`${errorType} on ${accountAlias} - See ${filename ?? 'API log'} at ${timestamp}`)
}

export function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export function configureLogging(next: LoggingOptions): void {
  const retentionDays = boundedNumber(next.log_retention_days, 1, 365)
  const maxTotalSizeMb = boundedNumber(next.log_max_total_size_mb, 16, 102400)
  const compressAfterDays = boundedNumber(next.log_compress_after_days, 1, 30)
  const segmentSizeMb = boundedNumber(next.log_segment_size_mb, 1, 256)
  segmentSizeBytes = segmentSizeMb * MEBIBYTE
  configureLogMaintenance({
    log_retention_days: retentionDays,
    log_max_total_size_mb: maxTotalSizeMb,
    log_compress_after_days: compressAfterDays
  })
}

export async function runLogMaintenanceNow(): Promise<void> {
  await runLogMaintenance()
}

export function resetLoggingForTests(): void {
  apiSegment = undefined
  apiSequence = 0
  pluginLogSequence = 0
  segmentSizeBytes = DEFAULT_OPTIONS.log_segment_size_mb * MEBIBYTE
  resetLogMaintenanceForTests()
}
