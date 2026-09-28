import {readVotingConfig, Config as VotingConfig} from '../src/config'

test('readVotingConfig can read a valid config', async () => {
  await expect(
    readVotingConfig('./__tests__/data/voting-valid.yml')
  ).resolves.toEqual(
    new VotingConfig({
      percentageToApprove: 75,
      minVotersRequired: 10,
      minVotingWindowMinutes: 3600
    })
  )
})

test('readVotingConfig has error on empty config', async () => {
  await expect(
    readVotingConfig('./__tests__/data/voting-empty.yml')
  ).rejects.toThrowError('config data is not object type')
})

test('readVotingConfig has no error on missing percentageToApprove', async () => {
  await expect(
    readVotingConfig('./__tests__/data/voting-missing-percentageToApprove.yml')
  ).resolves.toEqual(
    new VotingConfig({
      percentageToApprove: 0,
      minVotersRequired: 10,
      minVotingWindowMinutes: 3600
    })
  )
})

test('readVotingConfig has error on invalid percentageToApprove', async () => {
  await expect(
    readVotingConfig('./__tests__/data/voting-invalid-percentageToApprove.yml')
  ).rejects.toThrowError()
})

// 下面两条的测试名原写作 "has error on invalid minVotersRequired /
// minVotingWindowMinutes"，但断言写的是 `resolves`——名字说「会报错」、
// 断言说「不报错且被静默归 0」。名字与断言矛盾时，读者会按名字以为这条守住了
// fail-closed，实际上它固化的正是 fail-open 行为（AGENTS.md 已知坑：「断言写错
// 比没有断言更危险，因为它给出一个虚假的绿灯」）。此处只把名字改成与实际行为
// 一致，不改行为本身（改行为=收紧闸门，须维护者决策，见 PR 描述的提案）。

test('readVotingConfig 把负的 minVotersRequired 静默归 0（fail-open，见 PR 提案）', async () => {
  await expect(
    readVotingConfig('./__tests__/data/voting-invalid-minVotersRequired.yml')
  ).resolves.toEqual(
    new VotingConfig({
      percentageToApprove: 75,
      minVotersRequired: 0,
      minVotingWindowMinutes: 3600
    })
  )
})

test('readVotingConfig 把负的 minVotingWindowMinutes 静默归 0（fail-open，见 PR 提案）', async () => {
  await expect(
    readVotingConfig(
      './__tests__/data/voting-invalid-minVotingWindowMinutes.yml'
    )
  ).resolves.toEqual(
    new VotingConfig({
      percentageToApprove: 75,
      minVotersRequired: 10,
      minVotingWindowMinutes: 0
    })
  )
})

// 显式钉住「负数=闸门关闭」这个后果本身：minVotersRequired: -1 被归 0 后，
// evaluateVote 的 numVoters 检查 `votes.numVoters < 0` 恒为假 ⇒ 任意人数放行。
// 这条断言的作用是让该后果在测试里可见（而不是藏在 config 的归零里）。
test('【口径边界】minVotersRequired: -1 -> 归 0 -> 任意人数都通过（当前行为）', async () => {
  const cfg = await readVotingConfig(
    './__tests__/data/voting-invalid-minVotersRequired.yml'
  )
  expect(cfg.minVotersRequired).toBe(0)
  // 归 0 之后 evaluateVote 的判定：0 票也应放行（= 闸门已失效）
  const {evaluateVote} = await import('../src/voting')
  const msg = await evaluateVote(
    Promise.resolve(cfg),
    Promise.resolve({
      '+1': 0,
      '-1': 0,
      numVoters: 0,
      voteStartedAt: null
    })
  )
  expect(msg).toBe('')
})
