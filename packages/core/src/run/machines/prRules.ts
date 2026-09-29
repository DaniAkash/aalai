import { mayFixCi, mayRevise } from '@/run/budgets'
import { type Upshot, upshotOf } from '@/run/prCollect'
import type { PrContext } from './prTypes'

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
    headSha: context.headSha,
    baseSha: context.baseSha,
    lastCommentId: context.lastCommentId,
    failedChecks: context.failedChecks,
    pushedSha: context.pushedSha,
  },
  ...(context.pollMs === undefined ? {} : { pollMs: context.pollMs }),
})
