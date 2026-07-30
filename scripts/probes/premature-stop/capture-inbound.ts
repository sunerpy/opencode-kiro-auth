/**
 * Capture, for FREE, the exact OpenAI-shaped request bodies the plugin's custom `fetch`
 * receives from OpenCode at turn 1 and turn 2 of a tool loop.
 *
 * Why this exists: the plugin's own `api-*.ndjson` log deliberately replaces
 * `conversationState.history` with `historyLength` (`sdk-log-payload.ts`), so a production
 * log can never show the outbound history. To build a turn-2 variant probe whose V0
 * provably equals production, the honest route is to capture the INPUT instead and then
 * drive the real `transformToSdkRequest` over it.
 *
 * Mechanism: an isolated `XDG_CONFIG_HOME` declares provider id `kiro-auth` and model id
 * `claude-opus-5-high` — the SAME ids production uses, so OpenCode selects the same system
 * prompt and the same `@ai-sdk/openai-compatible` serializer — but points `baseURL` at a
 * local mock. The plugin itself is NOT loaded; the mock stands exactly where the plugin's
 * custom fetch stands. Turn 1 is answered with a `read` tool call for the fixture's first
 * ledger file, OpenCode really executes it, and turn 2 is captured verbatim before the mock
 * ends the conversation.
 *
 * ZERO API calls, ZERO quota, no writes to kiro.db, no change to the real config.
 *
 * Usage:
 *   bun run scripts/probes/premature-stop/capture-inbound.ts [--out <file.json>]
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const FIXTURE = join(REPO, 'scripts', 'probes', 'ab-opencode', 'fixture')
const OPENCODE_BIN =
  process.env.AB_OPENCODE_BIN ?? '/config/.local/share/mise/installs/opencode/1.18.5/opencode'
const SCRATCH = process.env.CAPTURE_SCRATCH ?? '/tmp/opencode/pstop-capture'
const PROVIDER_ID = 'kiro-auth'
const MODEL_ID = 'claude-opus-5-high'
const READ_TOOL = 'read'

function parseArgs(argv: readonly string[]): { out: string; hops: number } {
  let out = join(HERE, 'captured-inbound.json')
  let hops = 1
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out = String(argv[i + 1])
      i += 1
    } else if (argv[i] === '--hops' && argv[i + 1]) {
      hops = Number(argv[i + 1])
      i += 1
    }
  }
  if (!Number.isInteger(hops) || hops < 1) throw new Error('--hops must be a positive integer')
  return { out, hops }
}

/** Follow the fixture's chain the way the real agent does: read `next` out of the last result. */
function nextLedgerFile(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!isRecord(message) || message.role !== 'tool') continue
    const content = typeof message.content === 'string' ? message.content : ''
    const match = /"next":\s*"(step\d+)"/.exec(content)
    return match?.[1] ? `${match[1]}.json` : null
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

function sse(res: ServerResponse, chunks: readonly Record<string, unknown>[]): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function frame(
  delta: Record<string, unknown>,
  finishReason: string | null
): Record<string, unknown> {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  }
}

// The turn-1 text and the tool-use id shape are copied from the real stopped run
// `results/baseline/old-03`, so the captured turn-2 body carries the same first assistant turn
// a genuine premature stop was observed with.
function toolCallReply(argumentsJson: string, hop: number): readonly Record<string, unknown>[] {
  const id = `toolu_bdrk_01CaPtUrE${String(hop).padStart(16, '0')}`
  const text =
    hop === 1
      ? "I'll start by reading the first ledger file."
      : `hop ${hop - 1} folded. Reading the next ledger file.`
  return [
    frame({ role: 'assistant', content: text }, null),
    frame(
      {
        tool_calls: [
          {
            index: 0,
            id,
            type: 'function',
            function: { name: READ_TOOL, arguments: argumentsJson }
          }
        ]
      },
      null
    ),
    frame({}, 'tool_calls')
  ]
}

function findReadArgumentKey(tools: unknown): string {
  if (!Array.isArray(tools)) return 'filePath'
  for (const tool of tools) {
    if (!isRecord(tool)) continue
    const fn = isRecord(tool.function) ? tool.function : undefined
    if (!fn || fn.name !== READ_TOOL) continue
    const params = isRecord(fn.parameters) ? fn.parameters : {}
    const properties = isRecord(params.properties) ? params.properties : {}
    for (const key of Object.keys(properties)) {
      if (/path/i.test(key)) return key
    }
  }
  return 'filePath'
}

interface Captured {
  readonly index: number
  readonly body: Record<string, unknown>
}

async function main(): Promise<void> {
  const { out: outPath, hops: targetHops } = parseArgs(process.argv.slice(2))
  const runDir = join(SCRATCH, 'run')
  const cfgRoot = join(SCRATCH, 'config')
  const cfgDir = join(cfgRoot, 'opencode')
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(runDir, { recursive: true })
  mkdirSync(cfgDir, { recursive: true })
  cpSync(join(FIXTURE, 'ledger'), join(runDir, 'ledger'), { recursive: true })

  const captured: Captured[] = []
  let served = 0

  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req)
      if (!req.url || !req.url.includes('chat/completions')) {
        res.writeHead(404).end('{}')
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        res.writeHead(400).end('{}')
        return
      }
      if (!isRecord(parsed)) {
        res.writeHead(400).end('{}')
        return
      }
      // OpenCode fires a separate, TOOL-LESS title-generation request first. It is a real
      // request in production too, but it is not part of the tool loop under study, so it is
      // answered with a title and excluded from the capture.
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0
      if (!hasTools) {
        sse(res, [frame({ role: 'assistant', content: 'ledger audit' }, null), frame({}, 'stop')])
        return
      }

      captured.push({ index: served, body: parsed })
      served += 1

      const key = findReadArgumentKey(parsed.tools)
      const file = served === 1 ? 'step01.json' : nextLedgerFile(parsed.messages)
      if (served <= targetHops && file) {
        sse(res, toolCallReply(JSON.stringify({ [key]: join(runDir, 'ledger', file) }), served))
        return
      }
      sse(res, [frame({ role: 'assistant', content: 'capture complete' }, null), frame({}, 'stop')])
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  if (!port) throw new Error('mock server failed to bind a port')
  console.log(`mock OpenAI-compatible endpoint on http://127.0.0.1:${port}/v1`)

  writeFileSync(
    join(cfgDir, 'opencode.json'),
    `${JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        plugin: [],
        compaction: { auto: false, prune: false },
        provider: {
          [PROVIDER_ID]: {
            name: 'kiro capture mock',
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'mock' },
            models: { [MODEL_ID]: { name: 'capture mock opus 5 high' } }
          }
        }
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  const prompt = readFileSync(join(FIXTURE, 'PROMPT.md'), 'utf8')
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      OPENCODE_BIN,
      [
        'run',
        '--format',
        'json',
        '--auto',
        '--agent',
        'build',
        '--dir',
        runDir,
        '-m',
        `${PROVIDER_ID}/${MODEL_ID}`,
        prompt
      ],
      {
        cwd: runDir,
        env: { ...process.env, XDG_CONFIG_HOME: cfgRoot, OPENCODE_DISABLE_AUTOUPDATE: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    child.stdout.resume()
    child.stderr.resume()
    child.on('error', reject)
    child.on('close', resolve)
  })
  server.close()

  const turn1 = captured[0]
  const turn2 = captured[1]
  if (!turn1 || !turn2) {
    throw new Error(`expected >=2 inbound requests, captured ${captured.length} (exit ${exitCode})`)
  }

  const systemOf = (body: Record<string, unknown>): string => {
    const messages = Array.isArray(body.messages) ? body.messages : []
    const first = messages.find((m) => isRecord(m) && m.role === 'system')
    return isRecord(first) && typeof first.content === 'string' ? first.content : ''
  }
  const system = systemOf(turn2.body)

  const result = {
    schemaVersion: 1,
    probe: 'capture-inbound',
    capturedAt: new Date().toISOString(),
    opencodeBin: OPENCODE_BIN,
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    runDir,
    inboundRequests: captured.length,
    hopsRequested: targetHops,
    turns: captured.map((entry) => entry.body),
    systemPrompt: {
      length: system.length,
      sha256: createHash('sha256').update(system).digest('hex')
    },
    turn1: turn1.body,
    turn2: turn2.body
  }
  const serialized = JSON.stringify(result, null, 2)
  if (/sk-[A-Za-z0-9_-]{16,}/.test(serialized)) throw new Error('refusing to write an api key')
  if (/Bearer\s+\S{16,}/.test(serialized)) throw new Error('refusing to write a bearer token')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${serialized}\n`, 'utf8')

  const messages = Array.isArray(turn2.body.messages) ? turn2.body.messages : []
  const roles = messages.map((m) => (isRecord(m) ? String(m.role) : '?'))
  const tools = Array.isArray(turn2.body.tools) ? turn2.body.tools.length : 0
  console.log(
    `captured ${captured.length} inbound requests; turn2 roles=[${roles.join(',')}] ` +
      `tools=${tools} systemChars=${system.length}`
  )
  console.log(`wrote ${outPath} (${serialized.length} bytes)`)
  if (existsSync(outPath)) console.log('OK')
}

main().catch((error: unknown) => {
  console.error('CAPTURE FAILED', error)
  process.exit(1)
})
