import type { Database } from 'bun:sqlite'
import { openGate, supersedeOpenGates } from '@/modules/gates/gates'
import type { RunRef } from '@/modules/work/paths'
import { type RecordedAnswer, unsentAnswers } from '@/modules/work/reviews'

/**
 * Asking a person whether a review's answers may be sent.
 *
 * One gate for the whole review, carrying every answer. A review with eight
 * comments is one decision rather than eight, and the reason that is right is
 * not the notification count: the answers have to be read together, because
 * judging them one at a time is how the seventh gets released without anybody
 * noticing it contradicts the third.
 */

export interface ReviewRelease {
  readonly gateId: string
  readonly answers: readonly RecordedAnswer[]
}

/**
 * Opens the gate, retiring any older one on the same run.
 *
 * A reviewer can leave another comment while a gate is open, which makes the
 * batch on it no longer the whole review. Approving it then would post answers
 * to some comments and silently ignore the ones that arrived after the
 * question was asked, so the old gate is superseded and a fuller one replaces
 * it. That is what a plan gate already does when its plan moves underneath it.
 */
export async function openReviewRelease(
  db: Database,
  run: RunRef,
  generation: number,
): Promise<ReviewRelease | undefined> {
  const answers = await unsentAnswers(run.subject)
  if (answers.length === 0) {
    return undefined
  }
  // The id comes back from openGate rather than being computed alongside it.
  // Both call the same function, and computing it twice is how the generation
  // ends up in one of them and not the other.
  const id = openGate(db, {
    runId: run.runId,
    kind: 'review_reply',
    nonce: String(generation),
    summary: summarise(answers),
  })
  supersedeOpenGates(db, run.runId, 'review_reply', { except: id })
  return { gateId: id, answers }
}

/**
 * What the gate says before a person opens it.
 *
 * The count and the first few words of each, because an inbox row that says
 * only "replies are ready" makes a person open it to find out whether it is
 * worth opening.
 */
function summarise(answers: readonly RecordedAnswer[]): string {
  const count = answers.length
  const opening = answers
    .slice(0, 3)
    .map((answer) => answer.answer.trim().split('\n')[0]?.slice(0, 60) ?? '')
    .filter((line) => line !== '')
    .join(' / ')
  return count === 1
    ? `One reply is ready to send: ${opening}`
    : `${count} replies are ready to send: ${opening}${count > 3 ? ' ...' : ''}`
}
