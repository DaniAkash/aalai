import { emit } from '@/events/bus'
import type { GhIssue } from '@/lib/gh'
import { logger } from '@/lib/log'

/**
 * The parts of a run that only read or announce.
 *
 * Split from the pipeline because the pipeline is the order things happen in,
 * and these are details of two of those things. Nothing here decides anything.
 */

const log = logger('pipeline')

/** Where a run is picked back up from, and which machine wrote it. */
export interface ResumeFrom {
  readonly runId: string
  readonly snapshot: unknown
  /** Which machine wrote it, so it is restored into that one and no other. */
  readonly machine: string
}

/**
 * The persisted snapshot, but only for the machine that wrote it.
 *
 * A run parked in its triage gate, or waiting weeks on a reporter, would
 * otherwise restart by classifying from scratch, and its snapshot would go on
 * to be restored into a machine whose states it shares none of.
 */
export function snapshotFor(
  from: ResumeFrom | undefined,
  machine: string,
): { snapshot?: unknown } {
  if (from === undefined || from.machine !== machine) {
    return {}
  }
  return { snapshot: from.snapshot }
}

/** Says a run has begun, before anything exists that could fail. */
export function announceStart(
  runId: string,
  repo: string,
  issue: GhIssue,
): void {
  log.info('run starting', { repo, issue: issue.number, title: issue.title })
  emit({
    type: 'run.started',
    runId,
    repo,
    issue: issue.number,
    title: issue.title,
    at: Date.now(),
  })
  emit({ type: 'stage.entered', runId, stage: 'workspace', at: Date.now() })
}
