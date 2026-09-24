import type { Database } from 'bun:sqlite'
import type { Config } from '@/config'
import { emit } from '@/events/bus'
import { getIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import type { RunRef, Subject } from '@/modules/work/paths'
import { readSnapshot, unfinishedRuns } from '@/run/machines/snapshots'
import type { PipelineResult } from '@/run/pipeline'
import { resumeIssue } from '@/run/pipeline'

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
    const named = parseRunId(row.runId)
    if (named === undefined) {
      log.warn('run id not understood, leaving it alone', { runId: row.runId })
      continue
    }
    const subject: Subject = {
      repo: named.repo,
      kind: 'issue',
      number: named.issueNumber,
    }
    const run: RunRef = { subject, runId: row.runId }

    const snapshot = await readSnapshot(run)
    if (snapshot === undefined) {
      // The row says unfinished and the document is gone, so there is nothing
      // to carry on from. Left for the poller to claim again from the start.
      log.warn('no snapshot on disk, not resuming', { runId: row.runId })
      continue
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
      const result: PipelineResult = await resumeIssue(
        named.repo,
        issue,
        config,
        { runId: row.runId, snapshot },
      )
      log.info('resumed run finished', {
        runId: row.runId,
        status: result.status,
      })
      resumed += 1
    } catch (error) {
      log.error('could not resume', {
        runId: row.runId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return resumed
}
