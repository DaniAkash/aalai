import type { Database } from 'bun:sqlite'
import type { Config } from '@/config'
import { getIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import { getDb } from '@/modules/db/db'
import type { RunRef, Subject } from '@/modules/work/paths'
import { drivePullRequest } from '@/run/machines/drivePr'
import { keepsPullRequestsAlive } from '@/run/policy'
import { adoptWorkspace } from '@/run/workspace'
import { claimRun, completeRun, deliveredPullRequests } from '@/watch/state'

const log = logger('pr')

/**
 * Picks up pull requests the factory opened and nobody is watching yet.
 *
 * Here rather than at the end of delivery, for two reasons that turned out to
 * be the same one. Claiming belongs to this layer: it decides what to work on
 * and owns the claim while it does, and a run reaching into it to claim its own
 * successor crosses that line. And keeping a pull request alive takes days,
 * so starting it inside the run that opened it would leave that run unfinished
 * for as long as the pull request stayed open, holding a claim on the issue and
 * reporting nothing.
 *
 * So delivery records the pull request and ends, and this notices it on the next
 * pass exactly as it notices an issue.
 */
export async function watchDeliveredPullRequests(
  db: Database,
  config: Config,
): Promise<number> {
  let started = 0
  for (const delivered of deliveredPullRequests(db)) {
    if (!keepsPullRequestsAlive(config, delivered.repo)) {
      continue
    }
    if (await start(db, config, delivered)) {
      started += 1
    }
  }
  return started
}

async function start(
  db: Database,
  config: Config,
  delivered: {
    repo: string
    issueNumber: number
    prNumber: number
    branch: string
  },
): Promise<boolean> {
  // Claimed on the pull request's own subject, which is what stops a second
  // pass starting a second watch on the same one.
  const lease = claimRun(
    db,
    delivered.repo,
    delivered.prNumber,
    config.staleClaimMinutes * 60_000,
    'pr',
  )
  if (lease === null) {
    return false
  }

  const subject: Subject = {
    repo: delivered.repo,
    kind: 'pr',
    number: delivered.prNumber,
  }
  const runId = `${delivered.repo}#${delivered.prNumber}@${Date.now()}`
  const run: RunRef = { subject, runId }

  try {
    const issue = await getIssue(delivered.repo, delivered.issueNumber)
    const workspace = await adoptWorkspace(
      delivered.repo,
      delivered.issueNumber,
      issue.title,
    )
    if (workspace === undefined) {
      // The checkout the change was built in is gone, so a revision would have
      // nothing to revise. Said rather than retried, because it will be gone
      // on the next pass too.
      log.info('no checkout left for this pull request, leaving it', {
        repo: delivered.repo,
        pr: delivered.prNumber,
      })
      completeRun(db, delivered.repo, delivered.prNumber, {
        kind: 'pr',
        status: 'skipped',
        lease,
      })
      return false
    }

    log.info('watching a delivered pull request', {
      repo: delivered.repo,
      pr: delivered.prNumber,
    })
    const settled = await drivePullRequest({
      runId,
      repo: delivered.repo,
      prNumber: delivered.prNumber,
      issueNumber: delivered.issueNumber,
      run,
      deps: {
        db: getDb().sqlite,
        config,
        issue,
        repo: delivered.repo,
        workspace,
        run,
        conventionFiles: [],
      },
    })
    completeRun(db, delivered.repo, delivered.prNumber, {
      kind: 'pr',
      status: settled.outcome.kind === 'failed' ? 'failed' : 'delivered',
      lease,
      ...(settled.outcome.kind === 'failed'
        ? { error: settled.outcome.error }
        : {}),
    })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('could not watch the pull request', {
      repo: delivered.repo,
      pr: delivered.prNumber,
      error: message,
    })
    completeRun(db, delivered.repo, delivered.prNumber, {
      kind: 'pr',
      status: 'failed',
      error: message,
      lease,
    })
    return false
  }
}
