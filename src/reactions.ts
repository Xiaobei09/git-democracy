import * as core from '@actions/core'

import {GitHub} from '@actions/github/lib/utils'
import {Voters} from './voters'
import {inspect} from 'util'

type Octokit = InstanceType<typeof GitHub>

export const forIt = '+1'
export const againstIt = '-1'

export interface Reactions {
  [forIt]: number
  [againstIt]: number
  numVoters: number
  voteStartedAt: Date | null
}

const approved = 'APPROVED'
const changesRequested = 'CHANGES_REQUESTED'
const pendingReview = 'PENDING'

type UserReactions = Map<string, number>

// These are summarized reactions which is nice and simple but not useful if we
// need to limit voters in some way to only registered voters.
export async function readReactionsCounts(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<UserReactions> {
  // Iterate over the reviews and separate approvals and disapprovals
  const result = new Map<string, number>()

  // Fetch all reviews for the pull request
  for await (const response of octokit.paginate.iterator(
    octokit.rest.pulls.listReviews,
    {
      owner,
      repo,
      pull_number: issueNumber
    }
  )) {
    for (const review of response.data) {
      const login = review.user?.login
      if (login == null) {
        core.info('not counting vote of null user')
      } else {
        // A PENDING review is a draft somebody opened and never submitted
        // (GitHub reports submitted_at === null for it). Counting it as a vote
        // would overwrite that person's last real vote with a 0, silently
        // dropping a voter and making the vote fail for a reason that has
        // nothing to do with the vote itself.
        if (review.state === pendingReview && review.submitted_at == null) {
          core.info(
            `not counting unsubmitted ${pendingReview} review draft of ${login} as a vote`
          )
        } else {
          const vote = pullRequestReviewStateToNumber(review.state)
          result.set(login, vote)
        }
      }
    }
  }

  // add the author since they cannot review their own PR in Github
  // This has to run after every review has been read, otherwise a review of
  // the author would win over the +1 below.
  // TODO: could consolidate this call as it's used elsewhere
  const pullRequest = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: issueNumber
  })

  const pullRequestAuthor = pullRequest.data.user?.login
  if (pullRequestAuthor) {
    core.info(`Counting PR author as a +1 vote: ${pullRequestAuthor}`)
    result.set(pullRequestAuthor, pullRequestReviewStateToNumber(approved))
  }

  core.info(`readReactionsCounts: ${inspect(result)}`)
  return result
}

export async function weightedVoteTotaling(
  promisedUserReactions: Promise<UserReactions>,
  promisedVoters: Promise<Voters>,
  promisedVoteStartedAt: Promise<Date>
): Promise<Reactions> {
  const userReactions = await promisedUserReactions
  const voters = await promisedVoters

  let forItVotes = 0
  let againstItVotes = 0
  let numVoters = 0
  for (const [user, vote] of userReactions) {
    const voteWeight = voters.get(user) ?? 0

    if (voteWeight > 0 && vote !== 0) {
      numVoters++
    }

    if (vote > 0) {
      forItVotes += vote * voteWeight
    } else if (vote < 0) {
      againstItVotes += -vote * voteWeight
    }
  }
  return {
    [forIt]: forItVotes,
    [againstIt]: againstItVotes,
    numVoters,
    voteStartedAt: await promisedVoteStartedAt
  }
}

function pullRequestReviewStateToNumber(state: string): number {
  if (state === approved) {
    return 1
  } else if (state === changesRequested) {
    return -1
  } else {
    return 0
  }
}
