import { describe, expect, test } from 'bun:test'
import {
  accountLogAlias,
  bindRecoverySemanticSnapshot,
  createRecoverySemanticSnapshot,
  recoveryIdentityLogFields
} from '../core/request/recovery-request-identity.js'
import type { CodeWhispererMessage, KiroAuthDetails, SdkPreparedRequest } from '../plugin/types.js'

function prepared(
  conversationId: string,
  currentMessage: CodeWhispererMessage = {
    userInputMessage: {
      content: 'private prompt text',
      modelId: 'claude-opus-5',
      origin: 'AI_EDITOR'
    }
  }
): SdkPreparedRequest {
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId,
      history: [
        {
          assistantResponseMessage: {
            content: 'private response text',
            reasoningContent: {
              reasoningText: {
                text: 'private reasoning text',
                signature: 'private-signature'
              }
            }
          }
        }
      ],
      currentMessage
    },
    profileArn: 'arn:aws:codewhisperer:us-east-1:111111111111:profile/secret-a',
    streaming: true,
    effectiveModel: 'claude-opus-5',
    conversationId,
    region: 'us-east-1',
    effort: 'high'
  }
}

const accountB: KiroAuthDetails = {
  refresh: 'refresh-b',
  access: 'access-b',
  expires: Date.now() + 60_000,
  authMethod: 'idc',
  region: 'eu-west-1',
  profileArn: 'arn:aws:codewhisperer:eu-west-1:222222222222:profile/secret-b'
}

describe('recovery semantic request identity', () => {
  test('binds a frozen semantic snapshot to a fresh account envelope', () => {
    const snapshot = createRecoverySemanticSnapshot(prepared('wire-a'), {
      requestKind: 'normal',
      disableReasoningReplay: false
    })

    const rebound = bindRecoverySemanticSnapshot(snapshot, accountB)

    expect(rebound.conversationId).toBe('wire-a')
    expect(rebound.conversationState).toEqual(snapshot.conversationState)
    expect(rebound.conversationState).not.toBe(snapshot.conversationState)
    expect(rebound.profileArn).toBe(accountB.profileArn)
    expect(rebound.region).toBe('eu-west-1')
    expect(JSON.stringify(snapshot)).not.toContain(accountB.profileArn)

    const reboundReasoning =
      rebound.conversationState.history?.[0]?.assistantResponseMessage?.reasoningContent
        ?.reasoningText
    if (!reboundReasoning) throw new Error('expected rebound reasoning content')
    reboundReasoning.signature = 'mutated-after-bind'
    const frozenReasoning =
      snapshot.conversationState.history?.[0]?.assistantResponseMessage?.reasoningContent
        ?.reasoningText
    if (!frozenReasoning) throw new Error('expected frozen reasoning content')
    expect(frozenReasoning.signature).toBe('private-signature')
  })

  test('normalizes wire conversation IDs while preserving recovery correlation', () => {
    const first = createRecoverySemanticSnapshot(prepared('wire-a'), {
      requestKind: 'normal',
      disableReasoningReplay: false
    })
    const retransformed = createRecoverySemanticSnapshot(
      prepared('wire-b'),
      {
        requestKind: 'normal',
        disableReasoningReplay: false
      },
      first
    )

    expect(retransformed.semanticFingerprint).toBe(first.semanticFingerprint)
    expect(retransformed.recoveryGroupId).toBe(first.recoveryGroupId)
    expect(recoveryIdentityLogFields(retransformed)).toMatchObject({
      wireConversationId: 'wire-b',
      sameSemanticAsInitial: true,
      sameConversationIdAsInitial: false
    })
  })

  test('starts a new group when the transformed semantic request changes', () => {
    const first = createRecoverySemanticSnapshot(prepared('wire-a'), {
      requestKind: 'normal',
      disableReasoningReplay: false
    })
    const changed = createRecoverySemanticSnapshot(
      prepared('wire-b', {
        userInputMessage: {
          content: 'different prompt',
          modelId: 'claude-opus-5',
          origin: 'AI_EDITOR'
        }
      }),
      {
        requestKind: 'normal',
        disableReasoningReplay: false
      },
      first
    )

    expect(changed.semanticFingerprint).not.toBe(first.semanticFingerprint)
    expect(changed.recoveryGroupId).not.toBe(first.recoveryGroupId)
    expect(recoveryIdentityLogFields(changed)).toMatchObject({
      sameSemanticAsInitial: false,
      sameConversationIdAsInitial: false
    })
  })

  test('log identity and account aliases expose no request or account secrets', () => {
    const snapshot = createRecoverySemanticSnapshot(prepared('wire-secret'), {
      requestKind: 'compaction',
      disableReasoningReplay: false
    })
    const accountId = 'raw-account-id'
    const alias = accountLogAlias(accountId)
    const serialized = JSON.stringify({
      ...recoveryIdentityLogFields(snapshot),
      accountAlias: alias
    })

    expect(alias).toMatch(/^account-\d+$/)
    expect(serialized).not.toContain(accountId)
    expect(serialized).not.toContain('private prompt text')
    expect(serialized).not.toContain('private response text')
    expect(serialized).not.toContain('private reasoning text')
    expect(serialized).not.toContain('private-signature')
    expect(serialized).not.toContain('profile/secret-a')
    expect(serialized).toContain('"requestKind":"compaction"')
    expect(serialized).toContain('"semanticFingerprint"')
  })
})
