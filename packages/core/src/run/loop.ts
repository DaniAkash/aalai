import type { Config } from '@/config'
import { logger } from '@/lib/log'
import { reviewGate } from '@/run/gate'
import type { Analysis, Review } from '@/run/stations/schemas'

const log = logger('pipeline')

/** What committing the implementer's work produced. */
export type CommitOutcome = 'committed' | 'no-changes' | 'generated-only'

/**
 * Everything the loop needs from the outside world.
 *
 * Injected rather than imported so the eval suite can drive the real
 * orchestration with recording fakes. The order these are called in, and the
 * decisions taken between them, are the thing worth asserting; a test that
 * hand-writes the expected order asserts nothing about the code that produces
 * it.
 */
export interface LoopDeps {
  readonly implement: (revision?: Revision) => Promise<string>
  readonly commit: (attempt: number) => Promise<CommitOutcome>
  readonly review: () => Promise<Review>
}

export interface Revision {
  readonly review: Review
  readonly attempt: number
}

export type LoopOutcome =
  | {
      readonly kind: 'approved'
      readonly review: Review
      readonly implementerReport: string
    }
  | { readonly kind: 'stopped'; readonly reason: string }

/**
 * Implement, commit, review, and send back at most `maxRevisions` times.
 *
 * The commit happens before the review on purpose. It is local and unpushed,
 * and it is what lets the reviewer read the change from its own checkout rather
 * than from the working directory the implementer just left behind.
 */
export async function runReviewLoop(
  deps: LoopDeps,
  analysis: Analysis,
  config: Pick<Config, 'maxRevisions'>,
): Promise<LoopOutcome> {
  let revision: Revision | undefined
  let implementerReport = ''

  for (let attempt = 0; attempt <= config.maxRevisions; attempt += 1) {
    implementerReport = await deps.implement(revision)

    const committed = await deps.commit(attempt)
    if (committed === 'no-changes') {
      return { kind: 'stopped', reason: 'the agent made no file changes' }
    }
    if (committed === 'generated-only') {
      return {
        kind: 'stopped',
        reason: 'the agent changed only build or dependency output',
      }
    }

    const review = await deps.review()
    const passed = review.criteria_results.filter((r) => r.pass).length
    log.info('verdict', {
      verdict: review.verdict,
      criteria: `${passed}/${review.criteria_results.length}`,
      blocking: review.blocking_findings.length,
    })

    const gate = reviewGate(review, analysis)
    if (gate.ok) {
      return { kind: 'approved', review, implementerReport }
    }
    if (review.verdict === 'reject') {
      return {
        kind: 'stopped',
        reason: `the reviewer rejected the approach: ${review.summary}`,
      }
    }
    // An approve that fails the gate is not a revision request, it is a
    // malformed approval. Sending it back would ask the implementer to fix
    // nothing, so the run stops and says why.
    if (review.verdict === 'approve') {
      return { kind: 'stopped', reason: gate.reason }
    }

    revision = { review, attempt: attempt + 1 }
    log.warn('changes requested, sending back', { attempt: attempt + 1 })
  }

  return {
    kind: 'stopped',
    reason: `the reviewer still requested changes after ${config.maxRevisions} revisions`,
  }
}
