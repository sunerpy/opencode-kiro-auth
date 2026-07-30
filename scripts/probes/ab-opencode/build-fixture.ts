/**
 * Deterministic fixture generator for the end-to-end OpenCode A/B experiment.
 *
 * Two conditions:
 *   baseline (10 hops)  — the primary A/B condition.
 *   stress   (20 hops + a per-turn modular checksum) — a harder condition used to answer
 *            "what would it take to expose a difference" if baseline comes out a tie.
 *
 * In BOTH conditions the chain order is deliberately NON-sequential, so the agent cannot
 * predict the next filename and must read each file to learn it. That property is what makes
 * premature stopping observable: a stop leaves a measurable gap between the tool calls made
 * and the hops the chain requires.
 *
 * Run:  bun run scripts/probes/ab-opencode/build-fixture.ts [--variant baseline|stress|all]
 * Idempotent: identical output bytes on every run, so both arms see a byte-identical fixture.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Op = 'seed' | 'multiply' | 'add' | 'divide' | 'subtract'

interface Hop {
  readonly step: number
  readonly value: number
  readonly op: Op
}

interface StepFile {
  readonly value: number
  readonly op: Op
  readonly next: string | null
}

type Variant = 'baseline' | 'stress'

const CHECKSUM_MODULUS = 9973

const CHAINS: Readonly<Record<Variant, readonly Hop[]>> = {
  baseline: [
    { step: 1, value: 7, op: 'seed' },
    { step: 7, value: 6, op: 'multiply' },
    { step: 3, value: 58, op: 'add' },
    { step: 9, value: 4, op: 'divide' },
    { step: 5, value: 13, op: 'multiply' },
    { step: 2, value: 25, op: 'subtract' },
    { step: 10, value: 12, op: 'divide' },
    { step: 4, value: 143, op: 'add' },
    { step: 8, value: 8, op: 'divide' },
    { step: 6, value: 11, op: 'multiply' }
  ],
  stress: [
    { step: 1, value: 12, op: 'seed' },
    { step: 13, value: 7, op: 'multiply' },
    { step: 5, value: 116, op: 'add' },
    { step: 18, value: 8, op: 'divide' },
    { step: 9, value: 24, op: 'multiply' },
    { step: 2, value: 145, op: 'subtract' },
    { step: 16, value: 65, op: 'add' },
    { step: 7, value: 10, op: 'divide' },
    { step: 20, value: 15, op: 'multiply' },
    { step: 11, value: 60, op: 'subtract' },
    { step: 4, value: 9, op: 'divide' },
    { step: 15, value: 145, op: 'add' },
    { step: 8, value: 4, op: 'multiply' },
    { step: 19, value: 108, op: 'subtract' },
    { step: 6, value: 12, op: 'divide' },
    { step: 12, value: 13, op: 'multiply' },
    { step: 3, value: 62, op: 'add' },
    { step: 17, value: 8, op: 'divide' },
    { step: 10, value: 6, op: 'multiply' },
    { step: 14, value: 231, op: 'subtract' }
  ]
}

function stepName(step: number): string {
  return `step${String(step).padStart(2, '0')}`
}

function applyOp(total: number, hop: Hop): number {
  switch (hop.op) {
    case 'seed':
      return hop.value
    case 'multiply':
      return total * hop.value
    case 'add':
      return total + hop.value
    case 'divide':
      return total / hop.value
    case 'subtract':
      return total - hop.value
  }
}

interface FoldTrace {
  readonly hop: number
  readonly file: string
  readonly op: Op
  readonly value: number
  readonly runningTotal: number
}

function foldChain(chain: readonly Hop[]): {
  total: number
  checksum: number
  trace: FoldTrace[]
} {
  const trace: FoldTrace[] = []
  let total = 0
  let sum = 0

  chain.forEach((hop, index) => {
    total = applyOp(total, hop)
    if (!Number.isInteger(total)) {
      throw new Error(
        `Chain hop ${index + 1} (${stepName(hop.step)}) produced a non-integer total ${total}. ` +
          'The fixture must stay integral so grading is exact.'
      )
    }
    sum += total
    trace.push({
      hop: index + 1,
      file: `${stepName(hop.step)}.json`,
      op: hop.op,
      value: hop.value,
      runningTotal: total
    })
  })

  return { total, checksum: sum % CHECKSUM_MODULUS, trace }
}

function buildPrompt(variant: Variant, firstFile: string, hops: number): string {
  const checksumRule =
    variant === 'stress'
      ? `6. Also maintain a CHECKSUM: the sum of every running total you have produced so far,
   taken modulo ${CHECKSUM_MODULUS}. Recompute it from scratch after every hop by re-adding all
   running totals from hop 1 — never by incrementing a previous checksum.
`
      : ''

  const finalLines =
    variant === 'stress'
      ? `FINAL_TOTAL=<the integer running total after the last hop>
FINAL_CHECKSUM=<the checksum after the last hop>`
      : `FINAL_TOTAL=<the integer running total after the last hop>`

  const finalIntro =
    variant === 'stress'
      ? 'Your final message MUST end with exactly these lines and nothing after them:'
      : 'Your final message MUST end with exactly this line and nothing after it:'

  return `You are auditing a chained ledger under \`ledger/\`.

Rules — follow them exactly:

1. Start at \`ledger/${firstFile}\`.
2. Read EXACTLY ONE ledger file per assistant turn. Never read two ledger files in the
   same turn, never batch reads, and never guess a file's contents.
3. Each file looks like \`{"value": <int>, "op": "<op>", "next": "<stepNN or null>"}\`.
4. Maintain a running total. Fold the file you just read into it using its \`op\`:
   - \`seed\`     -> the running total BECOMES \`value\` (this only appears on the first hop)
   - \`multiply\` -> running total = running total * value
   - \`add\`      -> running total = running total + value
   - \`divide\`   -> running total = running total / value
   - \`subtract\` -> running total = running total - value
5. After every read, restate the ENTIRE fold from the first hop to the current one
   (\`hop N: file -> op value -> running total\`), recomputed from scratch. Do not carry
   forward a previously printed line without re-deriving it.
${checksumRule}${variant === 'stress' ? '7' : '6'}. Then follow \`next\`: read \`ledger/<next>.json\` on your NEXT turn.
${variant === 'stress' ? '8' : '7'}. When you read a file whose \`next\` is \`null\`, the chain is over. Stop reading and
   report the result.

The chain is ${hops} hops long. Every intermediate running total is an integer; if you
ever produce a fraction you have made an arithmetic error — recompute before continuing.

${finalIntro}

${finalLines}
`
}

function writeVariant(here: string, variant: Variant): void {
  const chain = CHAINS[variant]
  const firstHop = chain[0]
  if (!firstHop) throw new Error(`chain ${variant} must not be empty`)

  const fixtureDir = join(here, variant === 'baseline' ? 'fixture' : `fixture-${variant}`)
  const ledgerDir = join(fixtureDir, 'ledger')
  const { total, checksum, trace } = foldChain(chain)

  rmSync(ledgerDir, { recursive: true, force: true })
  mkdirSync(ledgerDir, { recursive: true })

  chain.forEach((hop, index) => {
    const nextHop = chain[index + 1]
    const file: StepFile = {
      value: hop.value,
      op: hop.op,
      next: nextHop ? stepName(nextHop.step) : null
    }
    writeFileSync(
      join(ledgerDir, `${stepName(hop.step)}.json`),
      `${JSON.stringify(file, null, 2)}\n`,
      'utf8'
    )
  })

  writeFileSync(
    join(fixtureDir, 'PROMPT.md'),
    buildPrompt(variant, stepName(firstHop.step), chain.length),
    'utf8'
  )

  writeFileSync(
    join(fixtureDir, 'expected.json'),
    `${JSON.stringify(
      {
        variant,
        hops: chain.length,
        entryFile: `${stepName(firstHop.step)}.json`,
        traversalOrder: trace.map((t) => t.file),
        fold: trace,
        expectedFinalTotal: total,
        ...(variant === 'stress'
          ? { checksumModulus: CHECKSUM_MODULUS, expectedFinalChecksum: checksum }
          : {})
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  console.log(
    `${variant}: ${chain.length} hops, expected FINAL_TOTAL=${total}` +
      (variant === 'stress' ? `, FINAL_CHECKSUM=${checksum}` : '')
  )
  for (const t of trace) {
    console.log(
      `  hop ${String(t.hop).padStart(2)} ${t.file.padEnd(13)} ${t.op.padEnd(9)} ${String(t.value).padStart(4)} -> ${t.runningTotal}`
    )
  }
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const argv = process.argv.slice(2)
  const flagIndex = argv.indexOf('--variant')
  const requested = flagIndex >= 0 ? argv[flagIndex + 1] : 'all'

  const variants: readonly Variant[] =
    requested === 'baseline'
      ? ['baseline']
      : requested === 'stress'
        ? ['stress']
        : ['baseline', 'stress']

  for (const variant of variants) writeVariant(here, variant)
}

main()
