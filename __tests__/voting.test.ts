import {evaluateVote} from '../src/voting'
import {Config} from '../src/config'
import {Reactions, againstIt, forIt} from '../src/reactions'

// 上游真实配置（SiliconMod/Silicon test 分支的 .voting.yml）
const UPSTREAM = new Config({
  percentageToApprove: 100,
  minVotersRequired: 3,
  minVotingWindowMinutes: 10
})

function votes(over: Partial<Reactions> = {}): Reactions {
  return {
    [forIt]: 0,
    [againstIt]: 0,
    numVoters: 0,
    voteStartedAt: new Date(Date.now() - 60 * 60 * 1000), // 一小时前：窗口已满
    ...over
  }
}

function evaluate(v: Reactions, cfg: Config = UPSTREAM) {
  return evaluateVote(Promise.resolve(cfg), Promise.resolve(v))
}

// ── 通过路径 ────────────────────────────────────────────────────────────────

test('票够 + 100% + 窗口已过 -> 返回空串（通过）', async () => {
  await expect(
    evaluate(votes({[forIt]: 3, [againstIt]: 0, numVoters: 3}))
  ).resolves.toBe('')
})

// ── 三个失败维度各自触发 ────────────────────────────────────────────────────

test('赞成率不足 -> 点名门槛百分比', async () => {
  // PR #50 的真实形状：2 赞成 / 1 反对 / 3 人 = 66.7%
  const msg = await evaluate(votes({[forIt]: 2, [againstIt]: 1, numVoters: 3}))
  expect(msg).toContain('required 100% voter approval')
  expect(msg).not.toContain('voters, did not have the required min')
  expect(msg).not.toContain('minimum voting window')
})

test('投票人不足 -> 点名实际人数与门槛', async () => {
  const msg = await evaluate(votes({[forIt]: 2, [againstIt]: 0, numVoters: 2}))
  expect(msg).toContain('Vote has 2 voters')
  expect(msg).toContain('required min 3 voters')
  expect(msg).not.toContain('voter approval')
})

test('窗口未满 -> 点名最早可判定时刻', async () => {
  const msg = await evaluate(
    votes({
      [forIt]: 3,
      [againstIt]: 0,
      numVoters: 3,
      voteStartedAt: new Date() // 此刻起算，10 分钟后才满
    })
  )
  expect(msg).toContain('minimum voting window of 10 minutes')
  expect(msg).toContain('Earliest time to end window is')
  expect(msg).not.toContain('voter approval')
})

test('三个维度同时不足 -> 三条理由都在（不能只报一条）', async () => {
  const msg = await evaluate(
    votes({
      [forIt]: 1,
      [againstIt]: 1,
      numVoters: 2,
      voteStartedAt: new Date()
    })
  )
  expect(msg).toContain('voter approval')
  expect(msg).toContain('Vote has 2 voters')
  expect(msg).toContain('minimum voting window')
})

// ── 两个「看起来像放行」的口径（vote_merge.py 在这两处更严）──────────────
// 这两条是本文件最有价值的部分：它们把 action 的真实边界钉成可复现的断言，
// 而不是靠注释里的「本脚本更严」这句话。

test('【口径边界】0 赞成 0 反对 -> 0/0=NaN，百分比检查【不触发】', async () => {
  // NaN < 100 为 false ⇒ 百分比这一条永远不产生失败消息。
  // 只要人数达标，action 就会放行一个「没有任何票」的 PR。
  // vote_merge.py 对同一情形有独立的「无任何有效票」守卫（fail-closed）。
  const msg = await evaluate(votes({[forIt]: 0, [againstIt]: 0, numVoters: 3}))
  expect(msg).not.toContain('voter approval')
  expect(msg).toBe('')
})

test('【口径边界】voteStartedAt=null -> 整段窗口检查被跳过', async () => {
  // if (votes.voteStartedAt) 为假 ⇒ 窗口维度完全不参与判定。
  // vote_merge.py 的 main() 在真实路径上用 `!updateTime` → reject 来 fail-closed，
  // 而 main.ts:45-48 的 null 只喂初始占位评论；本断言钉住的是 evaluateVote
  // 这个纯函数本身的边界（它没有上游保护）。
  const msg = await evaluate(
    votes({[forIt]: 3, [againstIt]: 0, numVoters: 3, voteStartedAt: null})
  )
  expect(msg).toBe('')
})

test('【口径边界】0 反对 + 人数不足时，百分比不会「顺手」补上缺口', async () => {
  // 只有 1 张赞成票（100%），但人数不够 -> 只报人数，不报百分比。
  // 这条防止后来者把两个条件写成 || 或把百分比算成 numVoters 的比例。
  const msg = await evaluate(votes({[forIt]: 1, [againstIt]: 0, numVoters: 1}))
  expect(msg).toContain('Vote has 1 voters')
  expect(msg).not.toContain('voter approval')
})

// ── 边界值 ────────────────────────────────────────────────────────────────

test('恰好等于门槛 -> 通过（用的是 < 而不是 <=）', async () => {
  await expect(
    evaluate(votes({[forIt]: 3, [againstIt]: 0, numVoters: 3}))
  ).resolves.toBe('')
})

test('反对票权重拉低加权百分比：4:1 加权 -> 80% < 100%', async () => {
  const msg = await evaluate(votes({[forIt]: 4, [againstIt]: 1, numVoters: 5}))
  expect(msg).toContain('required 100% voter approval')
})

test('minVotingWindowMinutes=0 -> 窗口维度恒不触发', async () => {
  const cfg = new Config({
    percentageToApprove: 100,
    minVotersRequired: 3,
    minVotingWindowMinutes: 0
  })
  await expect(
    evaluate(
      votes({
        [forIt]: 3,
        [againstIt]: 0,
        numVoters: 3,
        voteStartedAt: new Date()
      }),
      cfg
    )
  ).resolves.toBe('')
})

test('percentageToApprove=0 -> 任何比例都通过（含 0 赞成 0 反对）', async () => {
  const cfg = new Config({
    percentageToApprove: 0,
    minVotersRequired: 0,
    minVotingWindowMinutes: 0
  })
  await expect(
    evaluate(votes({[forIt]: 0, [againstIt]: 5, numVoters: 5}), cfg)
  ).resolves.toBe('')
})
