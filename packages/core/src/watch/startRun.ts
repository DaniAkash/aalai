import type { Config } from '@/config'
import { getIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import type { QueueEntry } from '@/modules/runs/queue'
import { runIssue } from '@/run/pipeline'
import { startReview } from '@/watch/reviews'
import { completeRun, openState } from '@/watch/state'

const log = logger('start')

/**
 * Does the work of one already claimed run.
 *
 * It opens its own connection rather than borrowing the caller's. Every caller
 * detaches this, and a request handler or a poll tick closes its connection as
 * soon as it returns, so a borrowed one would be shut under the first await.
 *
 * The row is settled here on every path, including a throw. A claimed row left
 * `running` holds a slot that nothing is using until its lease goes stale,
 * which on a machine that allows two is half the factory.
 */
export async function startQueued(
  config: Config,
  entry: QueueEntry,
  lease: string,
): Promise<void> {
  const db = openState()
  try {
    if (entry.kind === 'pr') {
      await startReview(db, config, entry.repo, entry.number, entry.title ?? '')
      return
    }
    // Fetched now rather than carried from discovery: something queued this
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('run threw', {
      repo: entry.repo,
      subject: `${entry.kind}#${entry.number}`,
      error: message,
    })
    completeRun(db, entry.repo, entry.number, {
      status: 'failed',
      error: message,
      lease,
      kind: entry.kind,
    })
  } finally {
    db.close()
  }
}
