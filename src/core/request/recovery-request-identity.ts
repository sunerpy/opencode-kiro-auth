import { createHash, randomUUID } from 'node:crypto'
import { extractRegionFromArn } from '../../constants.js'
import type {
  CodeWhispererRequest,
  KiroAuthDetails,
  SdkPreparedRequest
} from '../../plugin/types.js'
import type { KiroRequestKind } from './request-kind.js'

const FINGERPRINT_HEX_LENGTH = 16
const accountAliases = new Map<string, string>()

export interface RecoverySemanticSnapshot {
  readonly recoveryGroupId: string
  readonly semanticFingerprint: string
  readonly initialSemanticFingerprint: string
  readonly conversationState: CodeWhispererRequest['conversationState']
  readonly conversationId: string
  readonly initialConversationId: string
  readonly streaming: boolean
  readonly effectiveModel: string
  readonly effort?: SdkPreparedRequest['effort']
  readonly requestKind: KiroRequestKind
  readonly disableReasoningReplay: boolean
}

export interface RecoverySnapshotOptions {
  readonly requestKind: KiroRequestKind
  readonly disableReasoningReplay: boolean
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString('base64') }
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value

  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key]
    if (entry !== undefined) result[key] = canonicalize(entry)
  }
  return result
}

function cloneConversationState(
  state: CodeWhispererRequest['conversationState']
): CodeWhispererRequest['conversationState'] {
  return structuredClone(state)
}

function semanticFingerprint(
  prepared: SdkPreparedRequest,
  disableReasoningReplay: boolean
): string {
  const normalizedState = cloneConversationState(prepared.conversationState)
  normalizedState.conversationId = '<wire-conversation-id>'
  const canonical = canonicalize({
    conversationState: normalizedState,
    effectiveModel: prepared.effectiveModel,
    effort: prepared.effort,
    streaming: prepared.streaming,
    disableReasoningReplay
  })
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, FINGERPRINT_HEX_LENGTH)
}

export function createRecoverySemanticSnapshot(
  prepared: SdkPreparedRequest,
  options: RecoverySnapshotOptions,
  previous?: RecoverySemanticSnapshot
): RecoverySemanticSnapshot {
  const fingerprint = semanticFingerprint(prepared, options.disableReasoningReplay)
  const sameGroup =
    previous !== undefined &&
    previous.semanticFingerprint === fingerprint &&
    previous.requestKind === options.requestKind &&
    previous.disableReasoningReplay === options.disableReasoningReplay
  const conversationState = cloneConversationState(prepared.conversationState)

  return {
    recoveryGroupId: sameGroup ? previous.recoveryGroupId : randomUUID(),
    semanticFingerprint: fingerprint,
    initialSemanticFingerprint: previous?.initialSemanticFingerprint ?? fingerprint,
    conversationState,
    conversationId: prepared.conversationId,
    initialConversationId: previous?.initialConversationId ?? prepared.conversationId,
    streaming: prepared.streaming,
    effectiveModel: prepared.effectiveModel,
    ...(prepared.effort !== undefined ? { effort: prepared.effort } : {}),
    requestKind: options.requestKind,
    disableReasoningReplay: options.disableReasoningReplay
  }
}

export function bindRecoverySemanticSnapshot(
  snapshot: RecoverySemanticSnapshot,
  auth: KiroAuthDetails
): SdkPreparedRequest {
  return {
    conversationState: cloneConversationState(snapshot.conversationState),
    ...(auth.profileArn !== undefined ? { profileArn: auth.profileArn } : {}),
    streaming: snapshot.streaming,
    effectiveModel: snapshot.effectiveModel,
    conversationId: snapshot.conversationId,
    region: extractRegionFromArn(auth.profileArn) ?? auth.region,
    ...(snapshot.effort !== undefined ? { effort: snapshot.effort } : {})
  }
}

export function recoveryIdentityLogFields(
  snapshot: RecoverySemanticSnapshot
): Record<string, unknown> {
  return {
    recoveryGroupId: snapshot.recoveryGroupId,
    semanticFingerprint: snapshot.semanticFingerprint,
    wireConversationId: snapshot.conversationId,
    conversationId: snapshot.conversationId,
    requestKind: snapshot.requestKind,
    sameSemanticAsInitial: snapshot.semanticFingerprint === snapshot.initialSemanticFingerprint,
    sameConversationIdAsInitial: snapshot.conversationId === snapshot.initialConversationId
  }
}

export function accountLogAlias(accountId: string): string {
  const existing = accountAliases.get(accountId)
  if (existing) return existing
  const alias = `account-${accountAliases.size + 1}`
  accountAliases.set(accountId, alias)
  return alias
}
