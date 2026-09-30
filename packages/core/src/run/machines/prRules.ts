import { mayFixCi, mayRevise } from '@/run/budgets'
import { type Upshot, upshotOf } from '@/run/prCollect'
import type { PrContext, PrEvent, PrInput } from './prTypes'

/**
 * The questions the machine's guards ask, in one place.
 *
 * Here rather than inline because several guards ask the same two things and a
 * second copy of "can this afford what it is asking for" is a second answer
 * waiting to disagree with the first.
 */

/** What this batch amounts to, asked in one place so every guard agrees. */
export function upshot(context: PrContext): Upshot {
  return upshotOf({
    openedAt: context.openedAt ?? '',
    signals: context.pending,
  })
}

/**
 * Whether there is budget for what this batch asks.
 *
 * Asked of the two allowances separately. A batch carrying a failing check and
 * a review comment needs both, and running out of one must not quietly spend
 * the other.
 */
export function affordable(context: PrContext): boolean {
  const asked = upshot(context)
  if (asked.kind !== 'revise') {
    return true
  }
  const spent = { ciFixes: context.ciFixes, revisions: context.revisions }
  const allowance = {
    maxCiFixes: context.maxCiFixes,
    maxRevisions: context.maxRevisions,
  }
  return (
    (asked.failing.length === 0 || mayFixCi(spent, allowance)) &&
    (asked.asked.length === 0 || mayRevise(spent, allowance))
  )
}

export const watchInput = ({ context }: { context: PrContext }) => ({
  repo: context.repo,
  prNumber: context.prNumber,
  seen: {
    looked: context.looked,
    headSha: context.headSha,
    baseSha: context.baseSha,
    lastCommentId: context.lastCommentId,
    failedChecks: context.failedChecks,
    pushedSha: context.pushedSha,
  },
  ...(context.pollMs === undefined ? {} : { pollMs: context.pollMs }),
})

/** What a look established, kept so the next one compares rather than re-establishes. */
export const rememberSeen = {
  looked: ({ event }: { event: PrEvent }) =>
    event.type === 'LOOKED' ? event.seen.looked : false,
  headSha: ({ event }: { event: PrEvent }) =>
    event.type === 'LOOKED' ? event.seen.headSha : '',
  baseSha: ({ event }: { event: PrEvent }) =>
    event.type === 'LOOKED' ? event.seen.baseSha : '',
  lastCommentId: ({ event }: { event: PrEvent }) =>
    event.type === 'LOOKED' ? event.seen.lastCommentId : 0,
  failedChecks: ({ event }: { event: PrEvent }) =>
    event.type === 'LOOKED' ? [...event.seen.failedChecks] : [],
  pushedSha: ({ event }: { event: PrEvent }) =>
    event.type === 'LOOKED' ? event.seen.pushedSha : '',
}

/** The context a watch begins with, before it has looked at anything. */
export function startingFrom(input: PrInput): PrContext {
  return {
    runId: input.runId,
    repo: input.repo,
    prNumber: input.prNumber,
    maxCiFixes: input.maxCiFixes,
    maxRevisions: input.maxRevisions,
    ...watchKnobs(input),
    pending: [],
    // Nothing has been observed, which is not the same as having observed
    // nothing: the difference is what stops a first look reporting the pull
    // request's own base as having moved.
    looked: false,
    ciFixes: 0,
    revisions: 0,
    headSha: '',
    baseSha: '',
    lastCommentId: 0,
    failedChecks: [],
    pushedSha: '',
  }
}

/**
 * The optional knobs a watch is started with, spread once.
 *
 * Both the driver and the starting context list the same three, and two copies
 * of a list of optional fields is two places for one of them to be forgotten.
 */
export function watchKnobs(input: {
  issueNumber?: number
  pollMs?: number
  windowMs?: number
}): { issueNumber?: number; pollMs?: number; windowMs?: number } {
  return {
    ...(input.issueNumber === undefined
      ? {}
      : { issueNumber: input.issueNumber }),
    ...(input.pollMs === undefined ? {} : { pollMs: input.pollMs }),
    ...(input.windowMs === undefined ? {} : { windowMs: input.windowMs }),
  }
}
