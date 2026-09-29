import { fromCallback } from 'xstate'
import { authenticatedLogin } from '@/lib/gh'
import {
  branchHead,
  listCheckRuns,
  listReviewComments,
  pullRequestState,
} from '@/lib/ghPr'
import { logger } from '@/lib/log'
import { type Seen, seenAfter, signalsFrom } from '@/run/prSignals'
import { pollEvery } from './polling'

const log = logger('pr')

/** How often an open pull request is looked at. Minutes: nothing here is urgent. */
const POLL_MS = 2 * 60_000

interface WatchInput {
  readonly repo: string
  readonly prNumber: number
  readonly seen: Seen
  readonly pollMs?: number
}

/**
 * Watches a pull request that already exists.
 *
 * Polling rather than webhooks, because a desktop application has no address
 * anybody can deliver to. That is the same shape as the gate keeper and the
 * reporter watch and it has the same consequences: every fact is a comparison
 * against the last look rather than an event, so nothing is lost by missing a
 * tick, and the interval is minutes because none of this is urgent.
 *
 * One watch rather than one per signal. Four independent polls would ask the
 * same API four times and, worse, would report a failure and a comment as
 * unrelated arrivals when the whole point is to gather them into one revision.
 */
export const prWatch = fromCallback<{ type: string }, WatchInput>(
  ({ input, sendBack }) => {
    let seen = input.seen

    return pollEvery(
      input.pollMs ?? POLL_MS,
      async (stopped) => {
        if (stopped()) {
          return
        }
        const pr = await pullRequestState(input.repo, input.prNumber)
        if (stopped()) {
          return
        }
        if (pr.state !== 'OPEN') {
          sendBack({ type: 'PR_GONE' })
          return
        }

        const [me, head, base, checks, comments] = await Promise.all([
          authenticatedLogin(),
          branchHead(input.repo, pr.headRef),
          branchHead(input.repo, pr.baseRef),
          listCheckRuns(input.repo, pr.headSha),
          listReviewComments(input.repo, input.prNumber),
        ])
        if (stopped()) {
          return
        }

        const current = {
          headSha: pr.headSha,
          headAuthor: head.author,
          baseSha: base.sha,
          checks,
          comments,
          me,
        }
        const signals = signalsFrom(seen, current)
        seen = seenAfter(seen, current, signals)
        if (signals.length > 0) {
          log.info('something changed on the pull request', {
            repo: input.repo,
            pr: input.prNumber,
            signals: signals.map((s) => s.kind).join(','),
          })
          sendBack({ type: 'SIGNALS', signals })
        }
      },
      'look at the pull request',
    )
  },
)
