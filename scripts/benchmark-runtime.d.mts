// Type declarations for the benchmark child-runtime module (pure JS, dev-only).
import type { BenchArgs } from './benchmark-lib.mjs'

export function runWorkerEntry(args: BenchArgs): Promise<void>
