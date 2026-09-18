import type { Analysis, Review } from '@/run/stations/schemas'

export type Gate =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * Decides whether a review actually approves the work.
 *
 * The verdict alone is not enough. A station can return `approve` while one of
 * its own criterion results says `pass: false`, and a pull request that ships
 * with a failed row in its evidence table refutes the thing the table is for.
 * The contract is the analyst's criteria, so the gate checks the review against
 * that list rather than against itself: every criterion accounted for, every
 * one passing, before anything is pushed.
 */
export function reviewGate(review: Review, analysis: Analysis): Gate {
  if (review.verdict !== 'approve') {
    return { ok: false, reason: `the reviewer returned ${review.verdict}` }
  }

  const failed = review.criteria_results.filter((result) => !result.pass)
  if (failed.length > 0) {
    return {
      ok: false,
      reason: `the reviewer approved but ${failed.length} acceptance criterion did not pass`,
    }
  }

  const judged = new Set(review.criteria_results.map((result) => normalise(result.criterion)))
  const missing = analysis.acceptance_criteria.filter((c) => !judged.has(normalise(c)))
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `the reviewer left ${missing.length} of ${analysis.acceptance_criteria.length} acceptance criteria unjudged`,
    }
  }

  return { ok: true }
}

/** Criteria are echoed by an agent, so compare on content rather than on exact bytes. */
function normalise(criterion: string): string {
  return criterion.toLowerCase().replace(/\s+/g, ' ').replace(/[.`'"]/g, '').trim()
}
