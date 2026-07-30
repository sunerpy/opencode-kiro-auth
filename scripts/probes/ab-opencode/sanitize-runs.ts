/**
 * Produces the committable, secret-free copies of the raw run artifacts.
 *
 * Three transforms, all reported per file so the report can state exactly what was changed:
 *  - account emails become stable pseudonyms (`acct1`, `acct2`, ...) so cross-run account
 *    stickiness stays visible without publishing addresses;
 *  - `profileArn` keeps its shape but loses the AWS account id and profile id;
 *  - any opaque token-shaped run of >=100 base64url characters becomes `<redacted:len=N>`.
 *    Access/refresh tokens and reasoning signatures are the only values of that shape the
 *    plugin can emit, and both must never be committed.
 *
 * The plugin api log additionally carries the full tool schema on EVERY request, which is
 * identical boilerplate worth hundreds of kilobytes per run. It is replaced by `toolCount`,
 * making the committed api artifact a declared FILTERED DERIVATIVE rather than a raw copy.
 *
 * Usage:
 *   bun run scripts/probes/ab-opencode/sanitize-runs.ts --in <runsDir> --out <resultsDir>
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Options {
  readonly inDir: string
  readonly outDir: string
}

function parseArgs(argv: readonly string[]): Options {
  let inDir: string | undefined
  let outDir: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--in' && value) {
      inDir = value
      i += 1
    } else if (flag === '--out' && value) {
      outDir = value
      i += 1
    }
  }
  if (!inDir || !outDir) throw new Error('usage: --in <runsDir> --out <resultsDir>')
  return { inDir, outDir }
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const ARN = /arn:aws:codewhisperer:([a-z0-9-]+):\d+:profile\/[A-Za-z0-9]+/g
const OPAQUE_TOKEN = /[A-Za-z0-9_-]{100,}/g

class Redactor {
  private readonly pseudonyms = new Map<string, string>()
  emails = 0
  arns = 0
  tokens = 0

  private pseudonym(email: string): string {
    const existing = this.pseudonyms.get(email)
    if (existing) return existing
    const next = `acct${this.pseudonyms.size + 1}@redacted.invalid`
    this.pseudonyms.set(email, next)
    return next
  }

  apply(text: string): string {
    let out = text.replace(OPAQUE_TOKEN, (match) => {
      this.tokens += 1
      return `<redacted:len=${match.length}>`
    })
    out = out.replace(ARN, (_match, region: string) => {
      this.arns += 1
      return `arn:aws:codewhisperer:${region}:<redacted-account>:profile/<redacted>`
    })
    out = out.replace(EMAIL, (match) => {
      this.emails += 1
      return this.pseudonym(match)
    })
    return out
  }

  mapping(): Record<string, string> {
    return Object.fromEntries(this.pseudonyms)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripToolSchemas(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripToolSchemas)
  if (!isRecord(value)) return value

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'tools' && Array.isArray(item)) {
      out.toolCount = item.length
      continue
    }
    out[key] = stripToolSchemas(item)
  }
  return out
}

function filterApiLog(raw: string): string {
  const lines: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      lines.push(JSON.stringify(stripToolSchemas(JSON.parse(trimmed))))
    } catch {
      lines.push(trimmed)
    }
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

interface FileReport {
  readonly file: string
  readonly bytesIn: number
  readonly bytesOut: number
  readonly filtered: boolean
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  const redactor = new Redactor()
  const reports: FileReport[] = []

  mkdirSync(options.outDir, { recursive: true })

  for (const entry of readdirSync(options.inDir).sort()) {
    const runDir = join(options.inDir, entry)
    if (!statSync(runDir).isDirectory()) continue
    const outRunDir = join(options.outDir, entry)
    mkdirSync(outRunDir, { recursive: true })

    for (const name of ['meta.json', 'stream.jsonl', 'export.json', 'stderr.log', 'api.ndjson']) {
      const src = join(runDir, name)
      if (!existsSync(src)) continue
      const raw = readFileSync(src, 'utf8')
      const filtered = name === 'api.ndjson'
      const staged = filtered ? filterApiLog(raw) : raw
      // `*.log` is gitignored repo-wide, so the stderr capture is republished as `.txt`;
      // otherwise the committed evidence would silently lack it while the analyzer's
      // "0 stderr bytes" still looked like a pass.
      const outName = filtered ? 'api-filtered.ndjson' : name === 'stderr.log' ? 'stderr.txt' : name
      const sanitized = redactor.apply(staged)
      writeFileSync(join(outRunDir, outName), sanitized, 'utf8')
      reports.push({
        file: `${entry}/${outName}`,
        bytesIn: raw.length,
        bytesOut: sanitized.length,
        filtered
      })
    }
  }

  const indexSrc = join(options.inDir, 'index.json')
  if (existsSync(indexSrc)) {
    const raw = readFileSync(indexSrc, 'utf8')
    const sanitized = redactor.apply(raw)
    writeFileSync(join(options.outDir, 'index.json'), sanitized, 'utf8')
    reports.push({
      file: 'index.json',
      bytesIn: raw.length,
      bytesOut: sanitized.length,
      filtered: false
    })
  }

  writeFileSync(
    join(options.outDir, 'REDACTION.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        replacements: {
          emails: redactor.emails,
          profileArns: redactor.arns,
          opaqueTokens: redactor.tokens
        },
        pseudonymCount: Object.keys(redactor.mapping()).length,
        note: 'api-filtered.ndjson is a FILTERED derivative: per-request tool schemas were replaced by toolCount. Everything else is byte-preserved apart from the listed redactions.',
        files: reports
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  console.log(
    `sanitized ${reports.length} files -> ${options.outDir} (emails=${redactor.emails} arns=${redactor.arns} tokens=${redactor.tokens})`
  )
}

main()
