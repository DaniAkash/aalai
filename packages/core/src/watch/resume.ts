import type { Database } from 'bun:sqlite'
import type { Config } from '@/config'
import { emit } from '@/events/bus'
import { getIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import type { RunRef, Subject } from '@/modules/work/paths'
import { readSnapshot, unfinishedRuns } from '@/run/machines/snapshots'
import { resumeIssue } from '@/run/pipeline'
import { completeRun, takeOverRun } from '@/watch/state'

const log = logger('resume')

/** `owner/repo#42@1790000000000` is how a run names itself. */
const RUN_ID = /^(?<repo>[^#]+)#(?<issue>\d+)@\d+$/

export function parseRunId(
  runId: string,
): { repo: string; issueNumber: number } | undefined {
  const match = RUN_ID.exec(runId)
  const repo = match?.groups?.repo
  const issue = match?.groups?.issue
  return repo === undefined || issue === undefined
    ? undefined
    : { repo, issueNumber: Number(issue) }
}

/**
 * Picks up every run whose machine stopped somewhere other than an end state.
 *
 * Lives beside the poller rather than beside the pipeline: it decides what to
 * work on and owns the claim while it does, which is what the watch layer is.
 *
 * Called before polling, so a process that died mid run carries on rather than
 * leaving an issue claimed and a branch half written. Each resumption is
 * independent: one that cannot be picked up must not stop the others, because
 * the alternative is one stuck run blocking every other.
 */
export async function resumeUnfinished(
  db: Database,
  config: Config,
): Promise<number> {
  const pending = unfinishedRuns(db)
  if (pending.length === 0) {
    return 0
  }
  log.info('unfinished runs found', { count: pending.length })

  let resumed = 0
  for (const row of pending) {
    if (await resumeOne(db, config, row)) {
      resumed += 1
    }
  }
  return resumed
}

/**
 * Picks up one run, or explains why it could not.
 *
 * Every failure settles the claim rather than leaving it, because a run nobody
 * can resume otherwise blocks its issue until the lease goes stale.
 */
async function resumeOne(
  db: Database,
  config: Config,
  row: { runId: string; value: string },
): Promise<boolean> {
  const named = parseRunId(row.runId)
  if (named === undefined) {
    log.warn('run id not understood, leaving it alone', { runId: row.runId })
    return false
  }
  const subject: Subject = {
    repo: named.repo,
    kind: 'issue',
    number: named.issueNumber,
  }
  const run: RunRef = { subject, runId: row.runId }

  const snapshot = await readSnapshot(run)
  if (snapshot === undefined) {
    log.warn('no snapshot on disk, not resuming', { runId: row.runId })
    return false
  }

  // Taken over before anything runs. Without a claim two pollers can both
  // restore the same machine, and the fencing that makes a duplicate
  // observation harmless in the normal path is simply absent here.
  const lease = takeOverRun(db, named.repo, named.issueNumber)
  if (lease === null) {
    log.info('another worker owns this run, leaving it', { runId: row.runId })
    return false
  }

  try {
    const issue = await getIssue(named.repo, named.issueNumber)
    log.info('resuming', { runId: row.runId, state: row.value })
    emit({
      type: 'run.resumed',
      runId: row.runId,
      state: row.value,
      at: Date.now(),
    })
    const result = await resumeIssue(named.repo, issue, config, {
      runId: row.runId,
      snapshot,
    })
    // Settled with the lease, so a worker that was taken over cannot come back
    // and overwrite this. Without it the row stays claimed, the issue is
    // skipped by every later poll, and a delivered run looks unfinished.
    completeRun(db, named.repo, named.issueNumber, {
      status: result.status,
      ...(result.branch === undefined ? {} : { branch: result.branch }),
      ...(result.prUrl === undefined ? {} : { prUrl: result.prUrl }),
      ...(result.error === undefined ? {} : { error: result.error }),
      lease,
    })
    log.info('resumed run finished', {
      runId: row.runId,
      status: result.status,
    })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    completeRun(db, named.repo, named.issueNumber, {
      status: 'failed',
      error: `resume failed: ${message}`,
      lease,
    })
    log.error('could not resume', { runId: row.runId, error: message })
    return false
  }
}
