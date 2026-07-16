// Type declarations for the benchmark helper module (pure JS, dev-only tool).
export const MODES: readonly ['A', 'B', 'C']
export const MODE_LABELS: Record<'A' | 'B' | 'C', string>
export const RESULT_MARKER: string

export interface ModeConfig {
  account_selection_strategy: 'sticky'
  distribute_across_processes: boolean
  per_request_spread: boolean
  enable_log_api_request: boolean
  usage_tracking_enabled: boolean
  auto_sync_kiro_cli: boolean
}

export interface BenchArgs {
  workers: number
  reqs: number
  model: string
  region: string
  portBase: number
  prompt: string
  child: boolean
  mode: string | null
  worker: number
}

export interface PromptClassification {
  ok: boolean
  rateLimited: boolean
  status: number
  message: string
}

export interface LatencyStats {
  count: number
  mean: number
  p50: number
  p95: number
}

export interface ModelReport {
  displayModel: string
  wireId: string
  effort: string | null
}

export interface WorkerResult {
  latencies?: number[]
  success?: number
  errors?: number
  rateLimited?: number
}

export interface ModeResult {
  mode: string
  label: string
  wallMs: number
  totalReqs: number
  success: number
  errors: number
  rateLimited: number
  throughputReqPerSec: number
  latencyMs: { mean: number; p50: number; p95: number }
  distinctAccountsSelected: number
  perAccount: Record<string, number>
  workers?: Array<{ worker: number; messages: unknown[] }>
}

export interface RunOutcome {
  ok: boolean
  reasons: string[]
}

export interface ModeCEvidence {
  valid: boolean
  note: string
}

export interface RunOutcomePolicy {
  requireModeCSpread: boolean
}

// evaluateRunOutcome reads only the outcome-relevant fields of a mode result,
// including its per-account selection log; a full ModeResult satisfies this.
export interface ModeOutcomeInput {
  mode: string
  totalReqs: number
  success: number
  errors: number
  rateLimited: number
  perAccount: Record<string, number>
}

export function buildModeConfig(mode: string): ModeConfig
export function parseArgs(argv: string[]): BenchArgs
export function validateArgs(args: BenchArgs): string | null
export function evaluateRunOutcome(
  results: ModeOutcomeInput[],
  policy: RunOutcomePolicy
): RunOutcome
export function assessModeCEvidence(reqsPerWorker: number): ModeCEvidence
export function percentile(sorted: number[], p: number): number
export function aggregateLatencies(latencies: number[]): LatencyStats
export function classifyPromptResult(result: unknown): PromptClassification
export function summarizeEmails(logEntries: unknown[]): Record<string, number>
export function buildModelReport(
  displayModel: string,
  resolveVariant: (model: string) => { wireId: string; effort?: string }
): ModelReport
export function aggregateWorkerResults(
  mode: string,
  workerResults: WorkerResult[],
  wallMs: number,
  totalReqs: number,
  perAccount: Record<string, number>
): ModeResult
