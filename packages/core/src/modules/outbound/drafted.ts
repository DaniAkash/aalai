import type { RunRef } from '@/modules/work/paths'
import { queueOutbound } from '@/modules/work/store'
import {
  isActionable,
  mayBeAnsweredPublicly,
  type Triage,
} from '@/run/stations/schemas'

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
  /** Which judgement these belong to, so replaying it rewrites rather than adds. */
  generation = 0,
): Promise<number> {
  if (!mayBeAnsweredPublicly(triage) || isActionable(triage)) {
    return 0
  }
  const at = new Date().toISOString()
  let queued = 0
  const reply = (triage.reply ?? '').trim()
  if (reply !== '') {
    await queueOutbound(
      run,
      {
        kind: 'comment_on_issue',
        body: reply,
        station: 'classifier',
        queuedAt: at,
      },
      `triage-${generation}-reply`,
    )
    queued += 1
  }
  const reason = closingReason(triage)
  if (reason !== undefined) {
    await queueOutbound(
      run,
      {
        kind: 'close_issue',
        body: '',
        station: 'classifier',
        queuedAt: at,
        closeReason: reason,
      },
      `triage-${generation}-close`,
    )
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
  // Nothing that is still waiting on an answer gets closed, whatever it was
  // classified as. `missing` is what sends the machine off to wait weeks on the
  // reporter, so queueing a close beside the question would post the question
  // and shut the issue in the same breath, and then sit there waiting for a
  // reply to a thread nobody can reply to.
  //
  // Found by running a vague report through the real repository: it came back
  // as noise with four missing details and a close queued behind it. Keying
  // this on the classification rather than on the question being asked was the
  // mistake, because every classification can ask.
  if (triage.missing.length > 0) {
    return undefined
  }
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
