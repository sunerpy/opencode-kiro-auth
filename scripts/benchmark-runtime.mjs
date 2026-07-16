// Child-worker runtime for the account-distribution benchmark (dev tool — NOT
// shipped in dist). Each invocation is ONE distinct OpenCode process that opens
// a single session and sends REQS_PER_WORKER sequential prompts through provider
// `kiro-auth`, so the plugin's account selector, token refresher, model mapping,
// request transform, and SDK client all run for real.
//
// Kept separate from benchmark-distribution.mjs (the parent orchestrator) so
// each file owns one responsibility: this file owns the in-process OpenCode
// session lifecycle; the parent owns env isolation + child-process fan-out.
import { createOpencode } from '@opencode-ai/sdk'
import { RESULT_MARKER, classifyPromptResult } from './benchmark-lib.mjs'

/**
 * Run one benchmark worker to completion and emit its JSON result on stdout,
 * prefixed with RESULT_MARKER so the parent can extract it from log noise.
 * Never throws: any failure is folded into the result as an error entry, so the
 * parent always receives a parseable line and can aggregate a failure verdict.
 */
export async function runWorkerEntry(args) {
  const providerID = 'kiro-auth'
  const modelID = args.model
  let server
  const result = {
    worker: args.worker,
    mode: args.mode,
    latencies: [],
    success: 0,
    errors: 0,
    rateLimited: 0,
    messages: []
  }

  try {
    const opencode = await createOpencode({
      hostname: '127.0.0.1',
      port: args.portBase + args.worker,
      timeout: 60000,
      config: { logLevel: 'ERROR' }
    })
    server = opencode.server
    const client = opencode.client

    // Fixed title => OpenCode skips the auto title-generation request, so it
    // never contaminates the measured prompt calls.
    const created = await client.session.create({
      body: { title: `bench-${args.mode}-w${args.worker}` }
    })
    const sessionId = created?.data?.id
    if (!sessionId) {
      throw new Error(`session.create returned no id: ${JSON.stringify(created?.error ?? created)}`)
    }

    for (let i = 0; i < args.reqs; i++) {
      const t0 = performance.now()
      const res = await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID, modelID },
          parts: [{ type: 'text', text: args.prompt }]
        }
      })
      const ms = performance.now() - t0
      const c = classifyPromptResult(res)
      result.latencies.push(ms)
      if (c.ok) result.success++
      else {
        result.errors++
        if (c.rateLimited) result.rateLimited++
      }
      result.messages.push({ ok: c.ok, status: c.status, ms: Math.round(ms), note: c.message })
    }
  } catch (e) {
    result.errors++
    result.messages.push({
      ok: false,
      status: 0,
      ms: 0,
      note: (e?.message || String(e)).slice(0, 300)
    })
  } finally {
    // Best-effort close of the spawned OpenCode server; a close failure must not
    // mask the measured result we are about to emit.
    try {
      server?.close()
    } catch (closeErr) {
      result.messages.push({
        ok: false,
        status: 0,
        ms: 0,
        note: `server.close failed: ${(closeErr?.message || String(closeErr)).slice(0, 120)}`
      })
    }
  }

  process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`)
  // Give the spawned opencode server a moment to release its port before exit.
  await new Promise((r) => setTimeout(r, 200))
  process.exit(0)
}
