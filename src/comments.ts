import * as core from '@actions/core'

import {Reactions, againstIt, forIt} from './reactions'

import {Config} from './config'
import {GitHub} from '@actions/github/lib/utils'
import {inspect} from 'util'

type Octokit = InstanceType<typeof GitHub>

export class Comment {
  id: number
  createdAt: Date
  body: string

  constructor(commentResponse: CommentResponse) {
    if (commentResponse.body == null) {
      throw new Error('body must be defined')
    }

    this.id = commentResponse.id
    this.createdAt = new Date(commentResponse.created_at)
    this.body = commentResponse.body //this must be defined
  }
}

interface CommentResponse {
  id: number
  created_at: string
  body?: string | undefined
}

export async function findVotingComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  bodyIncludes: string
): Promise<Comment | null> {
  const {data: comments} = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber
  })

  const comment = comments.find(next => {
    return next.body?.includes(bodyIncludes)
  })

  if (!comment) {
    core.info(`cannot find comment on issue = ${issueNumber}`)
    return null
  }

  if (isNaN(comment.id)) {
    return Promise.reject(Error('commentId not a number'))
  }

  core.info(`comment: ${inspect(comment)}`)
  return new Comment(comment)
}

/** 把任意错误压成一行可读文本（日志里要能一眼看出是权限问题还是别的）。 */
function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'status' in error) {
    const {status, message} = error as {status?: number; message?: string}
    if (typeof status === 'number') {
      return `HTTP ${status}: ${message ?? 'unknown'}`
    }
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * 找（或重建）投票评论。
 *
 * 【为什么写失败不能抛出去】—— 计票本身只需要**读**权限（listComments /
 * listReviews / pulls.get）。GitHub 会把来自 fork 的 `pull_request` /
 * `pull_request_review` 事件上的 GITHUB_TOKEN 降级为只读，此时删/建评论必然
 * 403（`Resource not accessible by integration`）。而这个函数在旧实现里是
 * **先写评论、后算票**（见 main.ts：findOrRecreate 在 evaluateVote 之前），
 * 所以写失败会让整个 action 在**还没计票**时就抛错退出 —— 于是 required check
 * 变红的原因是「授权错误」而不是票数，运维会去查权限，真正的原因（票不够）
 * 反而被掩盖。
 *
 * 改为：写不进去就 core.warning 记一笔并返回 null，让计票照常进行，最终的
 * setFailed 只由真实的票数判定触发。
 */
export async function findOrRecreateVotingComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  bodyIncludes: string,
  createCommentBody: Promise<string>
): Promise<Comment | null> {
  const comment = await findVotingComment(
    octokit,
    owner,
    repo,
    issueNumber,
    bodyIncludes
  )

  if (comment?.id) {
    try {
      await octokit.rest.issues.deleteComment({
        owner,
        repo,
        comment_id: comment.id
      })
    } catch (error) {
      core.warning(
        `could not delete the previous voting comment (${describeError(
          error
        )}); the vote is still being tallied, only the comment stays stale.`
      )
    }
  }

  try {
    return await createVotingComment(
      octokit,
      owner,
      repo,
      issueNumber,
      await createCommentBody
    )
  } catch (error) {
    core.warning(
      `could not create a voting comment (${describeError(
        error
      )}); the vote is still being tallied, only the comment is missing.`
    )
    return null
  }
}

export async function createVotingComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<Comment> {
  const {data: comment} = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body
  })

  if (isNaN(comment.id)) {
    return Promise.reject(Error('commentId not a number'))
  }
  return new Comment(comment)
}

export async function updateVotingComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: Promise<number | null>,
  body: Promise<string>
): Promise<void> {
  const id = await commentId
  if (id === null || id === undefined) {
    // 没有评论可更新：说明建评论那步就没成功（通常是 fork PR 上的只读 token）。
    // 这里【不能】抛 —— 抛了等于把「评论没发出去」伪装成「投票失败」。
    core.warning(
      'no voting comment to update (none could be created with the available token); the vote tally itself was still evaluated and is reported in the job log.'
    )
    return
  }
  try {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: id,
      body: await body
    })
  } catch (error) {
    core.warning(
      `could not update the voting comment (${describeError(
        error
      )}); the vote tally itself was still evaluated and is reported in the job log.`
    )
  }
}

export async function createVotingCommentBody(
  serverURL: string,
  owner: string,
  repo: string,
  ref: string,
  bodyIncludes: string,
  votesPromise: Promise<Reactions>,
  acceptanceCriteriaPromise: Promise<Config>
): Promise<string> {
  const votes = await votesPromise
  const acceptanceCriteria = await acceptanceCriteriaPromise
  let commentBody = `
**${bodyIncludes}** ![Voting](${serverURL}/${owner}/${repo}/workflows/Voting/badge.svg?branch=${ref})
Vote on this by posting a PR with approval or needs changes.

Vote Summary:
  ${votes[forIt]} 👍
  ${votes[againstIt]} 👎

Acceptance Criteria:
  - ${acceptanceCriteria.percentageToApprove}% of weighted votes needs to be to approve
  - ${acceptanceCriteria.minVotersRequired} minimum # of unique voters required
`
  if (acceptanceCriteria.minVotingWindowMinutes !== 0) {
    commentBody += `  - at least ${acceptanceCriteria.minVotingWindowMinutes} minutes of voting`
  }
  return commentBody
}

export async function closeVotingComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  comment: Comment,
  bodyIncludes: string,
  closedVotingBodyTag: string
): Promise<void> {
  if (bodyIncludes === closedVotingBodyTag) {
    return Promise.reject(
      Error(
        'voting comment identifier and closed comment identifier cannot be equal'
      )
    )
  }

  const closedBody = comment.body.replace(bodyIncludes, closedVotingBodyTag)

  await updateVotingComment(
    octokit,
    owner,
    repo,
    Promise.resolve(comment.id),
    Promise.resolve(closedBody)
  )

  return
}

export async function commentToId(
  commit: Promise<Comment | null>
): Promise<number | null> {
  const comment = await commit
  return comment ? comment.id : null
}
