import {
  commentToId,
  findOrRecreateVotingComment,
  updateVotingComment
} from '../src/comments'
import {GitHub} from '@actions/github/lib/utils'

type Octokit = InstanceType<typeof GitHub>

/**
 * 403 的形状要跟 GitHub 真返回的一致：HttpError 带 status + message。
 * 生产上 main.ts 就是这么冒泡的（`HttpError: Resource not accessible by
 * integration`），所以这里照抄，否则测试等于在测一个不存在的错误类型。
 */
function forbidden(message = 'Resource not accessible by integration'): Error {
  return Object.assign(new Error(message), {status: 403})
}

function fakeOctokit(opts: {
  existing?: {id: number; created_at: string; body: string} | null
  deleteThrows?: Error
  createThrows?: Error
  updateThrows?: Error
}): {octokit: Octokit; calls: string[]} {
  const calls: string[] = []
  const rest = {
    issues: {
      listComments: async () => {
        calls.push('listComments')
        return {data: opts.existing ? [opts.existing] : []}
      },
      deleteComment: async () => {
        calls.push('deleteComment')
        if (opts.deleteThrows) throw opts.deleteThrows
        return {data: {}}
      },
      createComment: async () => {
        calls.push('createComment')
        if (opts.createThrows) throw opts.createThrows
        return {data: {id: 999, created_at: '2026-01-01T00:00:00Z', body: 'x'}}
      },
      updateComment: async () => {
        calls.push('updateComment')
        if (opts.updateThrows) throw opts.updateThrows
        return {data: {}}
      }
    }
  }
  return {octokit: {rest} as unknown as Octokit, calls}
}

const OWNER = 'SiliconMod'
const REPO = 'Silicon'
const NUM = 68
const BODY = 'Voting'

// 场景一：fork PR 上的只读 token —— deleteComment 403。
// 这是 R72 在生产上实测到的失败点（run 36357503139，PR #68，跨仓）。
// 旧实现在这里就把异常抛出去，于是【计票根本没发生】。
test('findOrRecreateVotingComment survives a 403 on delete', async () => {
  const f = fakeOctokit({
    existing: {id: 5858155369, created_at: '2026-01-01T00:00:00Z', body: BODY},
    deleteThrows: forbidden()
  })
  const comment = await findOrRecreateVotingComment(
    f.octokit,
    OWNER,
    REPO,
    NUM,
    BODY,
    Promise.resolve('new body')
  )
  // 拿不到旧评论的更新，但新评论仍要建出来，且不抛。
  expect(comment).not.toBeNull()
  expect(comment?.id).toBe(999)
  expect(f.calls).toEqual(['listComments', 'deleteComment', 'createComment'])
})

test('findOrRecreateVotingComment survives a 403 on create', async () => {
  const f = fakeOctokit({createThrows: forbidden()})
  const comment = await findOrRecreateVotingComment(
    f.octokit,
    OWNER,
    REPO,
    NUM,
    BODY,
    Promise.resolve('new body')
  )
  // 关键断言：返回 null 而不是抛。抛了就会让 main.ts 在计票前中止。
  expect(comment).toBeNull()
})

test('findOrRecreateVotingComment returns null when both writes 403', async () => {
  const f = fakeOctokit({
    existing: {id: 1, created_at: '2026-01-01T00:00:00Z', body: BODY},
    deleteThrows: forbidden(),
    createThrows: forbidden()
  })
  await expect(
    findOrRecreateVotingComment(
      f.octokit,
      OWNER,
      REPO,
      NUM,
      BODY,
      Promise.resolve('new body')
    )
  ).resolves.toBeNull()
})

// 场景二：没有评论 id 时更新评论必须是 no-op，而不是把 id=null 打到 API 上。
test('updateVotingComment is a no-op when there is no comment id', async () => {
  const f = fakeOctokit({})
  await expect(
    updateVotingComment(
      f.octokit,
      OWNER,
      REPO,
      Promise.resolve(null),
      Promise.resolve('b')
    )
  ).resolves.toBeUndefined()
  expect(f.calls).toEqual([])
})

test('updateVotingComment survives a 403', async () => {
  const f = fakeOctokit({updateThrows: forbidden()})
  await expect(
    updateVotingComment(
      f.octokit,
      OWNER,
      REPO,
      Promise.resolve(42),
      Promise.resolve('b')
    )
  ).resolves.toBeUndefined()
  expect(f.calls).toEqual(['updateComment'])
})

// 场景三：commentToId 的 null 传播。
test('commentToId returns null for a missing comment', async () => {
  await expect(commentToId(Promise.resolve(null))).resolves.toBeNull()
})

test('commentToId returns the id when the comment exists', async () => {
  const f = fakeOctokit({
    existing: {id: 7, created_at: '2026-01-01T00:00:00Z', body: BODY}
  })
  const comment = findOrRecreateVotingComment(
    f.octokit,
    OWNER,
    REPO,
    NUM,
    BODY,
    Promise.resolve('b')
  )
  await expect(commentToId(comment)).resolves.toBe(999)
})
