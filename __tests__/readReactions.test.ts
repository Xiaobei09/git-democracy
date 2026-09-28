import {GitHub} from '@actions/github/lib/utils'
import {readReactionsCounts, weightedVoteTotaling} from '../src/reactions'
import {Voters} from '../src/voters'

type Octokit = InstanceType<typeof GitHub>

/**
 * 这里必须纯 mock：仓库里既有的 `__tests__/reactions.test.ts` 会去打真实
 * GitHub API（需要 INPUT_TOKEN），跑起来会挂住。
 *
 * 全部断言都围绕一件事——「谁的票算数」必须只由**已提交**的 review 决定。
 * PENDING 是「有人开了 review 草稿但没提交」，GitHub 给它 submitted_at = null。
 */
function review(
  login: string | null,
  state: string,
  submittedAt: string | null,
  id = 1
): Record<string, unknown> {
  return {
    id,
    state,
    submitted_at: submittedAt,
    user: login === null ? null : {login}
  }
}

function fakeOctokit(opts: {
  reviewPages: Array<Array<Record<string, unknown>>>
  author?: string | null
}): {octokit: Octokit; calls: string[]} {
  const calls: string[] = []
  const listReviews = (): unknown => {
    calls.push('listReviews')
    return {data: []}
  }
  const get = async (): Promise<unknown> => {
    calls.push('pulls.get')
    return {
      data: {user: opts.author == null ? null : {login: opts.author}}
    }
  }
  const octokit = {
    rest: {pulls: {listReviews, get}},
    paginate: {
      iterator: async function* (endpoint: unknown): AsyncGenerator<unknown> {
        calls.push('paginate.iterator')
        void endpoint
        for (const page of opts.reviewPages) {
          yield {data: page}
        }
      }
    }
  }
  return {octokit: octokit as unknown as Octokit, calls}
}

const VOTERS = new Voters({
  Xiaobei09: 1,
  rt334: 1,
  by514: 1
})

describe('readReactionsCounts', () => {
  test('未提交的 PENDING 草稿不会抹掉已有的赞成票', async () => {
    // rt334 先 approve，随后开了个 review 草稿、没提交就离开了。
    // 草稿的 id 更大、排在数组末尾；旧代码会 pullRequestReviewStateToNumber
    // 把它算成 0 并 result.set 覆盖掉那张赞成票。
    const {octokit} = fakeOctokit({
      author: 'contributor',
      reviewPages: [
        [
          review('rt334', 'APPROVED', '2026-09-01T10:00:00Z', 100),
          review('rt334', 'PENDING', null, 200)
        ]
      ]
    })

    const result = await readReactionsCounts(octokit, 'o', 'r', 1)

    expect(result.get('rt334')).toBe(1)
  })

  test('PENDING 草稿不会把票变成「无人投票」（end-to-end 计数）', async () => {
    const {octokit} = fakeOctokit({
      author: 'contributor',
      reviewPages: [
        [
          review('rt334', 'APPROVED', '2026-09-01T10:00:00Z', 100),
          review('by514', 'APPROVED', '2026-09-01T10:01:00Z', 101),
          review('rt334', 'PENDING', null, 200),
          review('by514', 'PENDING', null, 201)
        ]
      ]
    })

    const result = await readReactionsCounts(octokit, 'o', 'r', 1)
    const tally = await weightedVoteTotaling(
      Promise.resolve(result),
      Promise.resolve(VOTERS),
      Promise.resolve(new Date('2026-09-01T00:00:00Z'))
    )

    // 关键：numVoters 保持 2（旧代码这里是 0）
    expect(tally.numVoters).toBe(2)
    expect(tally['+1']).toBe(2)
    expect(tally['-1']).toBe(0)
  })

  test('未提交的 PENDING 草稿不会抹掉已有的反对票', async () => {
    const {octokit} = fakeOctokit({
      author: 'contributor',
      reviewPages: [
        [
          review('by514', 'CHANGES_REQUESTED', '2026-09-01T10:00:00Z', 100),
          review('by514', 'PENDING', null, 200)
        ]
      ]
    })

    const result = await readReactionsCounts(octokit, 'o', 'r', 1)

    expect(result.get('by514')).toBe(-1)
  })

  test('作者本人被记成 +1（作者不能 review 自己的 PR）', async () => {
    const {octokit} = fakeOctokit({
      author: 'Xiaobei09',
      reviewPages: [[review('rt334', 'APPROVED', '2026-09-01T10:00:00Z', 100)]]
    })

    const result = await readReactionsCounts(octokit, 'o', 'r', 1)

    expect(result.get('Xiaobei09')).toBe(1)
  })

  test('作者 +1 在所有 review 之后生效：作者最后一条 review 也会被 +1 覆盖', async () => {
    // 旧代码把 pulls.get 放在分页循环里，作者 +1 会被后续页的 review 盖掉；
    // 新代码保证「作者恒为 +1」这一不变量只成立一次且在最后。
    const {octokit} = fakeOctokit({
      author: 'Xiaobei09',
      reviewPages: [
        [review('Xiaobei09', 'CHANGES_REQUESTED', '2026-09-01T10:00:00Z', 100)],
        [review('Xiaobei09', 'CHANGES_REQUESTED', '2026-09-01T11:00:00Z', 200)]
      ]
    })

    const result = await readReactionsCounts(octokit, 'o', 'r', 1)

    expect(result.get('Xiaobei09')).toBe(1)
  })

  test('多页 review 仍只调一次 pulls.get', async () => {
    const {octokit, calls} = fakeOctokit({
      author: 'Xiaobei09',
      reviewPages: [
        [review('rt334', 'APPROVED', '2026-09-01T10:00:00Z', 100)],
        [review('by514', 'APPROVED', '2026-09-01T10:01:00Z', 101)],
        [review('rt334', 'CHANGES_REQUESTED', '2026-09-01T10:02:00Z', 102)]
      ]
    })

    await readReactionsCounts(octokit, 'o', 'r', 1)

    expect(calls.filter(c => c === 'pulls.get')).toHaveLength(1)
  })

  test('后提交的意见覆盖先前的（CHANGES_REQUESTED 胜出）', async () => {
    const {octokit} = fakeOctokit({
      author: 'contributor',
      reviewPages: [
        [
          review('rt334', 'APPROVED', '2026-09-01T10:00:00Z', 100),
          review('rt334', 'CHANGES_REQUESTED', '2026-09-01T10:05:00Z', 101)
        ]
      ]
    })

    const result = await readReactionsCounts(octokit, 'o', 'r', 1)

    expect(result.get('rt334')).toBe(-1)
  })

  test('DISMISSED 记 0（撤票）', async () => {
    const {octokit} = fakeOctokit({
      author: 'contributor',
      reviewPages: [
        [review('rt334', 'APPROVED', '2026-09-01T10:00:00Z', 100)],
        [review('rt334', 'DISMISSED', '2026-09-02T10:00:00Z', 101)]
      ]
    })

    const result = await readReactionsCounts(octokit, 'o', 'r', 1)

    expect(result.get('rt334')).toBe(0)
  })

  test('user 为 null 的 review 被跳过', async () => {
    const {octokit} = fakeOctokit({
      author: 'contributor',
      reviewPages: [[review(null, 'APPROVED', '2026-09-01T10:00:00Z', 100)]]
    })

    const result = await readReactionsCounts(octokit, 'o', 'r', 1)

    // Map 里只应有作者那一条，null user 的 review 没留下任何 entry
    expect([...result.keys()]).toEqual(['contributor'])
  })

  test('submitted_at 为 null 但状态不是 PENDING 的 review 仍照常计入', async () => {
    // 只放过 PENDING 草稿这一种「未提交」，其它状态不因 submitted_at 缺失
    // 而被静默丢弃——避免把过滤条件写得过宽，反而吞掉真票。
    const {octokit} = fakeOctokit({
      author: 'contributor',
      reviewPages: [[review('rt334', 'APPROVED', null, 100)]]
    })

    const result = await readReactionsCounts(octokit, 'o', 'r', 1)

    expect(result.get('rt334')).toBe(1)
  })
})
