const MAX_PROSE_TAIL_CHARS = 1200

export type ForwardActionCommitmentKind =
  | 'zh_immediate_first_person'
  | 'zh_unfinished_action_sequence'
  | 'en_immediate_first_person'
  | 'en_unfinished_action_sequence'

const ZH_ACTION =
  '(?:派(?:出)?|分派|调用|运行|执行|启动|创建|修改|修复|编辑|补(?:上|充)?|添加|写入|检查|排查|核验|验证|测试|提交|推送|发布|部署|更新|安装|清理|继续(?:处理|执行|修复|排查|测试|实现)?|处理|实现)'
const ZH_IMMEDIATE_COMMITMENT = new RegExp(
  `^(?:[-+]\\s*|\\d+[.)、]\\s*)?(?:我\\s*(?:现在|马上|立即|这就)|(?:接下来|下面)\\s*我\\s*(?:会|将|要)(?:\\s*(?:现在|马上|立即))?)\\s*(?:先\\s*)?(?:开始\\s*)?${ZH_ACTION}`,
  'u'
)
const ZH_UNFINISHED_SELF_ACTION = new RegExp(
  `^(?:[-+]\\s*|\\d+[.)、]\\s*)?我\\s*(?:还没|还未|尚未|仍未)\\s*(?:完成\\s*)?${ZH_ACTION}`,
  'u'
)
const ZH_SEQUENCED_ACTION = new RegExp(
  `^(?:[-+]\\s*|\\d+[.)、]\\s*)?(?:然后|接着|随后|再)\\s*(?:我\\s*(?:会|将|要)\\s*)?(?:先\\s*)?${ZH_ACTION}`,
  'u'
)
const ZH_CONDITIONAL_OR_ADVISORY =
  /(?:如果|若(?:你|您)?|如需|需要的话|你(?:可以|可)|您(?:可以|可)|要不要|建议|推荐|计划|打算|可能|也许|之后(?:可以|再)|后续(?:可以|再))/u
const ZH_COMPLETED_OR_STATE =
  /(?:已经|已完成|已结束|完毕|无需|不用|不再|运行正常|执行正常|派不上|做不到)/u

const EN_ACTION =
  '(?:run|execute|call|dispatch|spawn|fork|launch|create|edit|modify|fix|patch|write|add|inspect|check|investigate|verify|test|commit|push|publish|release|deploy|update|install|clean|continue|resume|implement)'
const EN_IMMEDIATE_COMMITMENT = new RegExp(
  `^(?:[-+]\\s*|\\d+[.)]\\s*)?(?:(?:now|next),?\\s+)?I(?:'ll| will| am going to| am now going to)\\s+(?:(?:now|immediately|next)\\s+)?(?:(?:start|begin)\\s+(?:by|with)\\s+)?${EN_ACTION}\\b`,
  'i'
)
const EN_UNFINISHED_SELF_ACTION = new RegExp(
  `^(?:[-+]\\s*|\\d+[.)]\\s*)?I\\s+(?:(?:still\\s+)?(?:haven't|have not)(?:\\s+yet)?|still need to)\\s+${EN_ACTION}\\b`,
  'i'
)
const EN_SEQUENCED_ACTION = new RegExp(
  `^(?:[-+]\\s*|\\d+[.)]\\s*)?(?:then|next),?\\s+(?:(?:I'll|I will|I am going to)\\s+)?${EN_ACTION}\\b`,
  'i'
)
const EN_CONDITIONAL_OR_ADVISORY =
  /\b(?:if you(?:'d| would)? like|if you want|if needed|you can|would you like|I can|I could|recommend|suggest|might|maybe|later)\b/i
const EN_COMPLETED_OR_STATE =
  /\b(?:already|(?:is|are) now complete|all tests passed|no longer need)\b/i

function stripNonProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/\u2019/g, "'")
}

function substantiveSentences(text: string): string[] {
  const prose = stripNonProse(text).slice(-MAX_PROSE_TAIL_CHARS)
  return prose
    .split(/[。！？!?]\s*|\.\s+|\n\s*\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function hasUnfinishedActionSequence(
  sentences: string[],
  unfinished: RegExp,
  sequenced: RegExp,
  conditionalOrAdvisory: RegExp,
  completedOrState?: RegExp
): boolean {
  for (let index = 0; index < sentences.length - 1; index++) {
    const sentence = sentences[index]!
    if (
      !unfinished.test(sentence) ||
      conditionalOrAdvisory.test(sentence) ||
      completedOrState?.test(sentence)
    ) {
      continue
    }

    const followups = sentences.slice(index + 1, index + 4)
    const followupOffset = followups.findIndex(
      (followup) =>
        sequenced.test(followup) &&
        !conditionalOrAdvisory.test(followup) &&
        !completedOrState?.test(followup)
    )
    if (followupOffset < 0) continue

    const laterSentences = sentences.slice(index + followupOffset + 2)
    if (completedOrState && laterSentences.some((later) => completedOrState.test(later))) {
      continue
    }
    return true
  }
  return false
}

/**
 * Detects narrow prose-only endings that either explicitly promise immediate
 * agent action or leave a concrete self-owned action sequence unfinished. It
 * intentionally ignores broad plans and user-facing suggestions: false positives
 * would spend quota and can replay a valid final answer.
 */
export function detectForwardActionCommitment(text: string): ForwardActionCommitmentKind | null {
  const sentences = substantiveSentences(text)
  const lastSentence = sentences.at(-1)
  if (!lastSentence) return null

  if (
    ZH_IMMEDIATE_COMMITMENT.test(lastSentence) &&
    !ZH_CONDITIONAL_OR_ADVISORY.test(lastSentence) &&
    !ZH_COMPLETED_OR_STATE.test(lastSentence)
  ) {
    return 'zh_immediate_first_person'
  }
  if (
    hasUnfinishedActionSequence(
      sentences,
      ZH_UNFINISHED_SELF_ACTION,
      ZH_SEQUENCED_ACTION,
      ZH_CONDITIONAL_OR_ADVISORY,
      ZH_COMPLETED_OR_STATE
    )
  ) {
    return 'zh_unfinished_action_sequence'
  }
  if (
    EN_IMMEDIATE_COMMITMENT.test(lastSentence) &&
    !EN_CONDITIONAL_OR_ADVISORY.test(lastSentence)
  ) {
    return 'en_immediate_first_person'
  }
  if (
    hasUnfinishedActionSequence(
      sentences,
      EN_UNFINISHED_SELF_ACTION,
      EN_SEQUENCED_ACTION,
      EN_CONDITIONAL_OR_ADVISORY,
      EN_COMPLETED_OR_STATE
    )
  ) {
    return 'en_unfinished_action_sequence'
  }
  return null
}
