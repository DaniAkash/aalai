import { emit } from '@/events/bus'
import type { Stage } from '@/events/events.types'
import { logger } from '@/lib/log'
import type { IssueWorkContext } from './types'

const log = logger('pipeline')

/**
 * What a run tells anything watching, as it moves.
 *
 * Extracted from the machine so the state chart reads as transitions rather
 * than as event payloads, and so the shape of what is emitted is one place to
 * look rather than five.
 */
export function entered(context: IssueWorkContext, stage: Stage): void {
  emit({ type: 'stage.entered', runId: context.runId, stage, at: Date.now() })
}

export function revisionStarted(context: IssueWorkContext): void {
  if (context.revision === 0 || context.review === undefined) {
    return
  }
  emit({
    type: 'revision.started',
    runId: context.runId,
    attempt: context.revision,
    findings: context.review.blocking_findings,
    at: Date.now(),
  })
}

export function verdictReached(context: IssueWorkContext): void {
  const review = context.review
  if (review === undefined) {
    return
  }
  const passed = review.criteria_results.filter((r) => r.pass).length
  log.info('verdict', {
    verdict: review.verdict,
    criteria: `${passed}/${review.criteria_results.length}`,
    blocking: review.blocking_findings.length,
  })
  emit({
    type: 'review.verdict',
    runId: context.runId,
    verdict: review.verdict,
    results: review.criteria_results,
    at: Date.now(),
  })
}
