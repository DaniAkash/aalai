import { fromCallback } from 'xstate'
import { authenticatedLogin } from '@/lib/gh'
import {
  branchHead,
  listCheckRuns,
  listReviewComments,
  listReviewSummaries,
  pullRequestState,
  type ReviewComment,
  type ReviewSummary,
} from '@/lib/ghPr'
import { logger } from '@/lib/log'
import {
  readableReviewBody,
  recordReviewComments,
} from '@/modules/work/reviews'
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
  /** The issue whose thread this review belongs in, when there is one. */
  readonly issueNumber?: number
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
          // Which way it went, not merely that it went. A pull request closed
          // without merging reported as settled would be described to a person
          // as having green checks, which is the opposite of what happened.
          sendBack({ type: 'PR_CLOSED', state: pr.state })
          return
        }

        const [me, head, base, checks, comments, summaries] = await Promise.all(
          [
            authenticatedLogin(),
            branchHead(input.repo, pr.headRef),
            branchHead(input.repo, pr.baseRef),
            listCheckRuns(input.repo, pr.headSha),
            listReviewComments(input.repo, input.prNumber),
            listReviewSummaries(input.repo, input.prNumber),
          ],
        )
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
        // Written down before the signals are worked out, so what a person
        // reads in the thread does not depend on the machine deciding the
        // comment was worth acting on. A comment that changes nothing is
        // still something somebody said about this work.
        await rememberComments(input, comments, summaries)

        const signals = signalsFrom(seen, current)
        seen = seenAfter(seen, current, signals)
        if (signals.length > 0) {
          log.info('something changed on the pull request', {
            repo: input.repo,
            pr: input.prNumber,
            signals: signals.map((s) => s.kind).join(','),
          })
        }
        // Reported every time, even when nothing changed, because what this
        // look established has to reach the machine: the watch is rebuilt on
        // every state change and remembers nothing on its own.
        sendBack({ type: 'LOOKED', signals, seen })
      },
      'look at the pull request',
    )
  },
)

/**
 * Records what the review said, for the thread rather than for the machine.
 *
 * Failures are logged and swallowed. The watch is what keeps a pull request
 * alive, and losing that because a file could not be written would trade the
 * whole loop for one line of history.
 */
async function rememberComments(
  input: WatchInput,
  comments: readonly ReviewComment[],
  summaries: readonly ReviewSummary[],
): Promise<void> {
  if (input.issueNumber === undefined) {
    return
  }
  try {
    await recordReviewComments(
      { repo: input.repo, kind: 'issue', number: input.issueNumber },
      [
        // Summaries first: a reviewer says what it thinks overall before it
        // says it about a line, and the thread reads in that order.
        ...summaries.map((summary) => ({
          // Prefixed because review ids and comment ids are different numbers
          // from different tables, and an answer refers to one of them.
          id: `review:${summary.id}`,
          author: summary.author,
          body: readableReviewBody(summary.body),
          path: null,
          line: null,
          at: summary.submitted_at,
        })),
        ...comments.map((comment) => ({
          id: String(comment.id),
          author: comment.author,
          body: comment.body,
          path: comment.path ?? null,
          line: comment.line ?? null,
          at: comment.created_at,
        })),
      ],
    )
  } catch (error) {
    log.debug('could not record what the review said', { error })
  }
}
