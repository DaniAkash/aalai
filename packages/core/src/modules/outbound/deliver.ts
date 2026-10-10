import type { Database } from 'bun:sqlite'
import {
  authenticatedLogin,
  closeIssue,
  commentOnIssue,
  listIssueCommentBodies,
} from '@/lib/gh'
import {
  listReviewThreads,
  type PostedReply,
  replyInThread,
  replyToSummary,
  resolveReviewThread,
  threadHolding,
} from '@/lib/ghReview'
import { logger } from '@/lib/log'
import { listGates, readGate } from '@/modules/gates'
import type { RunRef } from '@/modules/work/paths'
import {
  markAnswerDelivered,
  type RecordedAnswer,
  readReviewRecords,
} from '@/modules/work/reviews'
import type { OutboundIntent, QueuedIntent } from '@/modules/work/store'
import {
  claimDelivery,
  readDelivery,
  readQueued,
  recordDelivery,
  releaseDelivery,
} from '@/modules/work/store'

const log = logger('outbound')

/**
 * Sends what stations wrote down, once a person has said it may go.
 *
 * Every station writes intents rather than posting, because a station that can
 * post is a station that can post from a poisoned issue body. This is the only
 * thing that turns one into a comment, and it is deliberately the dullest code
 * in the run: it reads a file, checks a gate, calls one API, and writes down
 * that it did.
 *
 * The rule it exists to enforce, which is a property rather than a convention:
 * **an intent whose gate nobody answered is not deliverable.** A station cannot
 * talk its way past that by writing a more convincing intent, because the
 * release is a fact about the gate row and not about the intent.
 */

export type Refusal =
  | { readonly kind: 'no_gate' }
  /** Somebody else is sending it right now, so this pass leaves it alone. */
  | { readonly kind: 'in_flight' }
  | { readonly kind: 'gate_unanswered'; readonly status: string }
  | { readonly kind: 'gate_missing' }

export interface Delivered {
  readonly id: string
  readonly kind: OutboundIntent['kind']
  readonly url?: string
  /** Whether this went out now or had already gone out before. */
  readonly source: 'sent' | 'already'
}

export interface DeliveryReport {
  readonly delivered: readonly Delivered[]
  readonly refused: readonly { id: string; refusal: Refusal }[]
  readonly failed: readonly { id: string; error: string }[]
}

/** Whether a person has released this intent. */
export function releasedBy(
  db: Database,
  intent: OutboundIntent,
): Refusal | undefined {
  if (intent.gateId === undefined || intent.gateId === '') {
    return { kind: 'no_gate' }
  }
  const gate = readGate(db, intent.gateId)
  if (gate === undefined) {
    return { kind: 'gate_missing' }
  }
  if (gate.status !== 'answered') {
    return { kind: 'gate_unanswered', status: gate.status }
  }
  return undefined
}

/**
 * Delivers everything this run has queued and released.
 *
 * Failures are collected rather than thrown. One comment failing to post must
 * not lose the others, and it must not make an answered gate look unanswered:
 * the intent stays queued and the next pass tries it again.
 */
export async function deliverOutbox(input: {
  db: Database
  run: RunRef
  repo: string
  issueNumber: number
  /**
   * A gate id this run released itself, for the one case with no person in it.
   *
   * A pull request the factory owns saying that a failing check was not caused
   * by its own change is not a station speaking for the maintainer about
   * somebody else's issue, and there is no gate on that run for the intent to
   * wait behind. Naming a sentinel keeps the rule one rule: an intent still has
   * to say what released it.
   */
  released?: string
}): Promise<DeliveryReport> {
  const delivered: Delivered[] = []
  const refused: { id: string; refusal: Refusal }[] = []
  const failed: { id: string; error: string }[] = []

  for (const queued of await readQueued(input.run)) {
    const outcome = await deliverOrSay(input, queued)
    if (outcome.kind === 'delivered') {
      delivered.push(outcome.delivered)
    } else if (outcome.kind === 'refused') {
      refused.push({ id: queued.id, refusal: outcome.refusal })
    } else {
      failed.push({ id: queued.id, error: outcome.error })
    }
  }

  return { delivered, refused, failed }
}

async function deliverOne(
  input: { run: RunRef; repo: string; issueNumber: number },
  queued: QueuedIntent,
): Promise<{ kind: OutboundIntent['kind']; url?: string }> {
  const { intent } = queued

  if (intent.kind === 'close_issue') {
    await closeIssue(
      input.repo,
      input.issueNumber,
      intent.closeReason ?? 'not_planned',
    )
    await recordDelivery(input.run, queued.id, {
      deliveredAt: new Date().toISOString(),
    })
    return { kind: intent.kind }
  }

  if (intent.kind === 'reply_to_review') {
    return await deliverReply(input, queued, intent)
  }

  // A kind this does not know how to send is refused rather than guessed at.
  // Falling through would post a reply meant for a review thread as a comment
  // on the issue, which is the wrong place and cannot be taken back.
  if (intent.kind !== 'comment_on_issue') {
    throw new Error(`no way to deliver a ${intent.kind}`)
  }

  // Looked for before it is sent. A crash between the comment landing and the
  // record of it being written is the one case that would otherwise post twice,
  // and the comment itself is the only evidence that survives a restart.
  const existing = await alreadyPosted(input, intent.body)
  const posted =
    existing ??
    (await commentOnIssue(input.repo, input.issueNumber, intent.body))
  await recordDelivery(input.run, queued.id, {
    deliveredAt: new Date().toISOString(),
    url: posted.html_url,
  })
  return { kind: intent.kind, url: posted.html_url }
}

/**
 * The comment this intent would post, if a previous attempt already posted it.
 *
 * Matched on the body, which is what aalai wrote and nobody else would have
 * written verbatim. Imperfect, and the imperfection favours the safe direction:
 * an unrecognised comment is posted again, a recognised one is not.
 */
async function alreadyPosted(
  input: { repo: string; issueNumber: number },
  body: string,
): Promise<{ html_url: string } | undefined> {
  try {
    // Ours, not anybody's. A reporter who quotes the draft back, or an earlier
    // run of a different issue that said something as ordinary as "thanks for
    // reporting this", would otherwise be read as evidence that this intent had
    // already gone out, and it would silently never be sent.
    const [comments, me] = await Promise.all([
      listIssueCommentBodies(input.repo, input.issueNumber),
      authenticatedLogin(),
    ])
    return comments.find(
      (comment) => comment.author === me && comment.body.trim() === body.trim(),
    )
  } catch {
    // Not being able to look is not evidence that it is not there, but the
    // alternative is never delivering anything when the read fails.
    return undefined
  }
}

/**
 * The gate whose answer released this run's outbound, if one has been answered.
 *
 * Anything queued after the fact rides on it: a follow-up question and the
 * close that eventually gives up both belong to the decision a person already
 * made, and neither should ask them again.
 */
export function releasingGate(db: Database, runId: string): string | undefined {
  const [answered] = listGates(db, { runId, status: 'answered' })
  return answered?.id
}

type OneOutcome =
  | { kind: 'delivered'; delivered: Delivered }
  | { kind: 'refused'; refusal: Refusal }
  | { kind: 'failed'; error: string }

/**
 * One intent: sent, refused, or failed.
 *
 * Split out because the loop above had grown every reason at once and the
 * reasons are not related to each other: a gate nobody answered, a record
 * saying it already went, a claim somebody else holds, and a send that threw.
 */
async function deliverOrSay(
  input: {
    db: Database
    run: RunRef
    repo: string
    issueNumber: number
    released?: string
  },
  queued: QueuedIntent,
): Promise<OneOutcome> {
  const refusal =
    input.released !== undefined && queued.intent.gateId === input.released
      ? undefined
      : releasedBy(input.db, queued.intent)
  if (refusal !== undefined) {
    return { kind: 'refused', refusal }
  }

  const already = await readDelivery(input.run, queued.id)
  if (already !== undefined) {
    return {
      kind: 'delivered',
      delivered: {
        id: queued.id,
        kind: queued.intent.kind,
        ...(already.url === undefined ? {} : { url: already.url }),
        source: 'already',
      },
    }
  }

  // Claimed before the send, not after. Everything above this line is a read,
  // and two workers can pass all of it at once.
  if (!(await claimDelivery(input.run, queued.id))) {
    return { kind: 'refused', refusal: { kind: 'in_flight' } }
  }

  try {
    const result = await deliverOne(input, queued)
    // The delivery record is what stops a resend from here on, so the claim has
    // done its job and only clutters the directory.
    await releaseDelivery(input.run, queued.id)
    return {
      kind: 'delivered',
      delivered: { id: queued.id, ...result, source: 'sent' },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('an intent could not be delivered, leaving it queued', {
      id: queued.id,
      kind: queued.intent.kind,
      error: message,
    })
    // Handed back so a later pass can try again. The record of a success is
    // what stops a resend, and there is no record here.
    await releaseDelivery(input.run, queued.id)
    return { kind: 'failed', error: message }
  }
}

/**
 * Posts one answer where the reviewer asked, and closes the thread.
 *
 * The words come from the review record rather than from the intent, so an
 * answer corrected between being queued and being released sends the
 * correction. The intent is a pointer and a gate, not a second copy of a
 * sentence that can disagree with the first.
 *
 * Posting and resolving are separate calls and the first is the one that
 * cannot be taken back, so it is recorded before the second is attempted. A
 * crash in between leaves an answer that is sent and not resolved, which a
 * retry finishes rather than repeats.
 */
async function deliverReply(
  input: { run: RunRef; repo: string; issueNumber: number },
  queued: QueuedIntent,
  intent: OutboundIntent,
): Promise<{ kind: OutboundIntent['kind']; url?: string }> {
  const threadId = intent.threadId
  if (threadId === undefined) {
    throw new Error('a reply with no comment to reply to')
  }
  const subject = input.run.subject
  const answer = (await readReviewRecords(subject))
    .filter((record): record is RecordedAnswer => record.kind === 'answer')
    .filter((record) => record.threadId === threadId)
    .at(-1)
  const body = (answer?.answer ?? intent.body).trim()
  if (body === '') {
    throw new Error('a reply with nothing in it')
  }

  const prNumber = intent.prNumber ?? input.issueNumber
  const posted = await post(input.repo, prNumber, threadId, body)
  const postedAt = new Date().toISOString()
  await markAnswerDelivered(subject, threadId, {
    postedAt,
    postedUrl: posted.html_url,
  })
  await recordDelivery(input.run, queued.id, {
    deliveredAt: postedAt,
    url: posted.html_url,
  })

  // A summary has no thread to close, which is an ordinary outcome and not a
  // failure: there was never anything there for a reviewer to tick off.
  if (!threadId.startsWith('review:')) {
    const threads = await listReviewThreads(input.repo, prNumber)
    const thread = threadHolding(threads, threadId)
    if (thread !== undefined && !thread.isResolved) {
      await resolveReviewThread(thread.id)
      await markAnswerDelivered(subject, threadId, {
        resolvedAt: new Date().toISOString(),
      })
    }
  }

  return { kind: intent.kind, url: posted.html_url }
}

function post(
  repo: string,
  prNumber: number,
  threadId: string,
  body: string,
): Promise<PostedReply> {
  return threadId.startsWith('review:')
    ? replyToSummary(repo, prNumber, body)
    : replyInThread(repo, prNumber, threadId, body)
}
