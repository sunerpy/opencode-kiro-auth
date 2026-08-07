import { describe, expect, test } from 'bun:test'
import { detectForwardActionCommitment } from '../core/request/action-commitment.js'

describe('detectForwardActionCommitment', () => {
  test('detects the observed Chinese dispatch promise', () => {
    const text = [
      '好消息是没有自写 dblclick，平台检测也正确。',
      '',
      '我现在派两个并行任务：标题栏与窗口 chrome 的完整修复，以及命令外壳的 mock_builder 覆盖。'
    ].join('\n')

    expect(detectForwardActionCommitment(text)).toBe('zh_immediate_first_person')
  })

  test('detects immediate Chinese and English execution commitments', () => {
    expect(detectForwardActionCommitment('问题已经定位。我马上运行聚焦测试。')).toBe(
      'zh_immediate_first_person'
    )
    expect(
      detectForwardActionCommitment("The defect is isolated. I'll now run the focused tests.")
    ).toBe('en_immediate_first_person')
  })

  test('detects the observed unfinished verification sequence before a later blocker note', () => {
    const text = [
      '## 剩下要做的',
      '',
      '我还没核验：全套 guards、workspace 测试，以及两批改动合并后是否互不干扰。',
      '',
      '然后提交、推送。真实渲染目前只能如实标注为未验证。',
      '',
      '另一个推送通道我还没做；它需要你在屏幕前登录。'
    ].join('\n')

    expect(detectForwardActionCommitment(text)).toBe('zh_unfinished_action_sequence')
  })

  test('detects the equivalent unfinished English action sequence', () => {
    const text = [
      'I have not yet run the focused guards or verified the combined changes.',
      'Then I will commit and push.',
      'The visual check still requires an interactive login.'
    ].join(' ')

    expect(detectForwardActionCommitment(text)).toBe('en_unfinished_action_sequence')
  })

  test('rejects offers, advice, plans, and already-completed statements', () => {
    const finals = [
      '如果你愿意，我可以继续修复。',
      '下一步你可以运行聚焦测试。',
      '建议接下来派两个并行任务。',
      '后续计划是补充回归测试。',
      '我现在已经完成了两个任务。',
      '我现在运行正常。',
      '模型最后说“我现在运行测试”。',
      '我还没核验真实渲染，因为需要你在屏幕前登录。本轮先停在这里。',
      '我还没核验。然后你可以提交、推送。',
      '我还没核验 guards。然后运行测试。测试已经完成，全部通过。',
      '旧日志写着“我还没核验，然后提交、推送”。当前任务已经完成。',
      "If you'd like, I'll run the focused tests.",
      'You can now run the focused tests.',
      'I already ran the focused tests.',
      'I have not verified the visual flow because it needs your login. This run stops here.',
      'I have not run the guards. Then you can commit and push.',
      'I have not run the guards. Then I will run them. All tests passed.'
    ]

    expect(finals.map(detectForwardActionCommitment)).toEqual(finals.map(() => null))
  })

  test('ignores superseded, quoted, or fenced immediate commitments', () => {
    expect(
      detectForwardActionCommitment(
        ['我现在运行测试。', '', '最终结论：当前实现无需继续修改。'].join('\n')
      )
    ).toBeNull()
    expect(detectForwardActionCommitment('> 我现在运行测试。\n\n当前实现无需继续修改。')).toBeNull()
    expect(
      detectForwardActionCommitment('```text\n我现在运行测试。\n```\n\n当前实现无需继续修改。')
    ).toBeNull()
  })
})
