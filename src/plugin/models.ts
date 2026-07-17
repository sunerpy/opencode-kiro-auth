import { MODEL_MAPPING, SUPPORTED_MODELS, getModelContextLimit } from '../constants'
import type { Effort } from './types'

export function resolveKiroModel(model: string): string {
  const resolved = MODEL_MAPPING[model]
  if (!resolved) {
    throw new Error(`Unsupported model: ${model}. Supported models: ${SUPPORTED_MODELS.join(', ')}`)
  }
  return resolved
}

const VARIANT_BASE_ALLOWLIST = new Set<string>([
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna'
])

const EFFORT_SUFFIXES: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export interface ResolvedModelVariant {
  wireId: string
  effort?: Effort
}

/**
 * Resolve a (possibly effort-variant) model id into its Kiro wire id plus an
 * optional parsed effort level.
 *
 * Parse rule (unambiguous, single source of truth):
 * An id is an effort variant ONLY IF it ends with `-<suffix>` for some suffix
 * in EFFORT_SUFFIXES AND the id with that `-<suffix>` removed is in
 * VARIANT_BASE_ALLOWLIST. In that case the wire id is derived SOLELY from the
 * base via MODEL_MAPPING and the effort SOLELY from the parsed suffix.
 *
 * This guarantees ids like `claude-opus-4-8-thinking`, `claude-sonnet-4-5-1m`,
 * and the plain bases (`claude-opus-4-8`) are NEVER parsed as effort variants.
 * Non-variant ids fall through to `resolveKiroModel` (existing behavior/throw)
 * with `effort` left undefined.
 */
export function resolveModelVariant(model: string): ResolvedModelVariant {
  for (const suffix of EFFORT_SUFFIXES) {
    const marker = `-${suffix}`
    if (model.endsWith(marker)) {
      const base = model.slice(0, -marker.length)
      if (VARIANT_BASE_ALLOWLIST.has(base)) {
        return { wireId: resolveKiroModel(base), effort: suffix }
      }
    }
  }
  return { wireId: resolveKiroModel(model), effort: undefined }
}

export function stripModelSuffix(model: string): string {
  for (const suffix of EFFORT_SUFFIXES) {
    const marker = `-${suffix}`
    if (model.endsWith(marker)) {
      const base = model.slice(0, -marker.length)
      if (VARIANT_BASE_ALLOWLIST.has(base)) {
        return base
      }
    }
  }
  if (model.endsWith('-thinking')) {
    const base = model.slice(0, -'-thinking'.length)
    if (MODEL_MAPPING[base]) {
      return base
    }
  }
  return model
}

export function getContextWindowSize(model: string): number {
  return getModelContextLimit(stripModelSuffix(model))
}
