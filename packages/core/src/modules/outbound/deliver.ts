import type { Database } from 'bun:sqlite'
import { closeIssue, commentOnIssue, listIssueCommentBodies } from '@/lib/gh'
import { logger } from '@/lib/log'
import { listGates, readGate } from '@/modules/gates'
import type { RunRef } from '@/modules/work/paths'
import type { OutboundIntent, QueuedIntent } from '@/modules/work/store'
import {
  queueOutbound,
  readDelivery,
  readQueued,
  recordDelivery,
} from '@/modules/work/store'
import {
  isActionable,
  mayBeAnsweredPublicly,
  type Triage,
} from '@/run/stations/schemas'

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
/**
 * Turns what the classifier drafted into something a person can release.
 *
 * The station writes its reply into the report and queues nothing, because a
 * station is not allowed to decide that anything reaches a stranger. This is
 * the step between: the words it chose become an intent, and the intent waits
 * on a gate like every other.
 *
 * A security report drafts nothing at all, whatever the station wrote. The
 * whole point of routing it away from the public is that its text never reaches
 * a comment box, and refusing it here rather than at delivery means there is
 * nothing queued to leak if a later change forgets why.
 */
export async function queueDraftedReply(
  run: RunRef,
  triage: Triage,
): Promise<number> {
  if (!mayBeAnsweredPublicly(triage) || isActionable(triage)) {
    return 0
  }
  const at = new Date().toISOString()
  let queued = 0
  const reply = (triage.reply ?? '').trim()
  if (reply !== '') {
    await queueOutbound(run, {
      kind: 'comment_on_issue',
      body: reply,
      station: 'classifier',
      queuedAt: at,
    })
    queued += 1
  }
  const reason = closingReason(triage)
  if (reason !== undefined) {
    await queueOutbound(run, {
      kind: 'close_issue',
      body: '',
      station: 'classifier',
      queuedAt: at,
      closeReason: reason,
    })
    queued += 1
  }
  return queued
}

/**
 * Why an issue would be closed, or nothing when it stays open.
 *
 * A question that has been answered is completed. A duplicate or noise was
 * never going to be done, which is what `not_planned` means and is what keeps
 * it out of a repository's record of work finished.
 */
function closingReason(
  triage: Triage,
): 'completed' | 'not_planned' | undefined {
  switch (triage.classification) {
    case 'question':
      return 'completed'
    case 'duplicate':
    case 'noise':
      return 'not_planned'
    default:
      return undefined
  }
}

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
}): Promise<DeliveryReport> {
  const delivered: Delivered[] = []
  const refused: { id: string; refusal: Refusal }[] = []
  const failed: { id: string; error: string }[] = []

  for (const queued of await readQueued(input.run)) {
    const refusal = releasedBy(input.db, queued.intent)
    if (refusal !== undefined) {
      refused.push({ id: queued.id, refusal })
      continue
    }
    const already = await readDelivery(input.run, queued.id)
    if (already !== undefined) {
      delivered.push({
        id: queued.id,
        kind: queued.intent.kind,
        ...(already.url === undefined ? {} : { url: already.url }),
        source: 'already',
      })
      continue
    }
    try {
      const result = await deliverOne(input, queued)
      delivered.push({ id: queued.id, ...result, source: 'sent' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('an intent could not be delivered, leaving it queued', {
        id: queued.id,
        kind: queued.intent.kind,
        error: message,
      })
      failed.push({ id: queued.id, error: message })
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
    const comments = await listIssueCommentBodies(input.repo, input.issueNumber)
    return comments.find((comment) => comment.body.trim() === body.trim())
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
