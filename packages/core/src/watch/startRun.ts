import type { Database } from 'bun:sqlite'
import type { Config } from '@/config'
import { getIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import type { QueueEntry } from '@/modules/runs/queue'
import { runIssue } from '@/run/pipeline'
import { startReview } from '@/watch/reviews'
import { claimRun, completeRun } from '@/watch/state'

const log = logger('start')

/**
 * Starts one queued run, whichever kind it is.
 *
 * The scheduler decides how many may run; this decides what running one means.
 * Keeping the two apart is what lets the ceiling be tested without GitHub and
 * the machines be tested without a queue.
 */
export async function startQueued(
  db: Database,
  config: Config,
  entry: QueueEntry,
): Promise<void> {
  if (entry.kind === 'pr') {
    await startReview(db, config, entry.repo, entry.number, entry.title ?? '')
    return
  }
  const lease = claimRun(
    db,
    entry.repo,
    entry.number,
    config.staleClaimMinutes * 60_000,
  )
  if (lease === null) {
    // Something else took it between the scheduler picking it and this call.
    log.debug('already claimed', { repo: entry.repo, issue: entry.number })
    return
  }
  // Fetched here rather than carried from discovery: an issue queued this
  // morning and started this afternoon should run against what it says now.
  const issue = await getIssue(entry.repo, entry.number)
  const result = await runIssue(entry.repo, issue, config)
  const recorded = completeRun(db, entry.repo, entry.number, {
    status: result.status,
    branch: result.branch,
    prUrl: result.prUrl,
    error: result.error,
    lease,
  })
  if (!recorded) {
    log.warn('result discarded, the claim was taken over', {
      repo: entry.repo,
      issue: entry.number,
    })
  }
  log.info('run finished', {
    repo: entry.repo,
    issue: entry.number,
    status: result.status,
  })
}
