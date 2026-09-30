import type { Database } from 'bun:sqlite'
import type { Config } from '@/config'
import { getIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import type { RunRef, Subject } from '@/modules/work/paths'
import { drivePullRequest } from '@/run/machines/drivePr'
import { readSnapshot } from '@/run/machines/snapshots'
import { keepsPullRequestsAlive } from '@/run/policy'
import { reviveWorkspace } from '@/run/workspace'
import { holdReviewClaim } from '@/watch/prClaim'
import {
  abandonedPullRequests,
  claimRun,
  completeRun,
  deliveredBranch,
  deliveredPullRequests,
} from '@/watch/state'

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
export function watchDeliveredPullRequests(
  db: Database,
  config: Config,
): number {
  let started = 0
  // Both kinds in one pass: pull requests nothing has watched yet, and ones
  // whose worker went away and whose claim has gone quiet. They need exactly the
  // same treatment, so telling them apart here would only mean two code paths
  // for one job, and the resumed half is the one that had no heartbeat when
  // there were two.
  for (const delivered of [
    ...deliveredPullRequests(db),
    ...resumable(db, config),
  ]) {
    if (!keepsPullRequestsAlive(config, delivered.repo)) {
      continue
    }
    if (inFlight.has(key(delivered.repo, delivered.prNumber))) {
      continue
    }
    // Started, not awaited. This watch has no timeout by design and can sit for
    // days, so awaiting it here would stop the poller: no other repository, no
    // new issue and no settings change would be looked at until the pull
    // request closed. The claim is what keeps it from being started twice, and
    // the set below is what keeps this process from doing so before the claim
    // is even written.
    const running = key(delivered.repo, delivered.prNumber)
    inFlight.add(running)
    void start(db, config, delivered)
      .catch((error: unknown) => {
        log.error('a pull request watch ended badly', {
          repo: delivered.repo,
          pr: delivered.prNumber,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        inFlight.delete(running)
      })
    started += 1
  }
  return started
}

/**
 * Watches this process has going, so one pass does not start a second.
 *
 * The claim in the database is the fence between processes. This is the fence
 * within one: a claim is written inside `start`, and the poller can come round
 * again before that has happened.
 */
const inFlight = new Set<string>()

function key(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`
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
    // Rebuilt from the branch rather than adopted. A successful delivery
    // removes its worktree, so by the time anything comes back to keep the pull
    // request alive the checkout it was built in is normally gone.
    const workspace = await reviveWorkspace(
      delivered.repo,
      delivered.issueNumber,
      issue.title,
      delivered.branch,
    )

    log.info('watching a delivered pull request', {
      repo: delivered.repo,
      pr: delivered.prNumber,
    })
    const holding = holdReviewClaim(
      db,
      config,
      delivered.repo,
      delivered.prNumber,
      lease,
    )

    try {
      // Restored when there is one. A watch coming back after a restart keeps the
      // baseline it had established, rather than starting blank and reporting the
      // pull request's own base as having moved.
      const snapshot = await readSnapshot(run)
      const settled = await drivePullRequest({
        signal: holding.signal,
        ...(snapshot === undefined ? {} : { snapshot }),
        runId,
        repo: delivered.repo,
        prNumber: delivered.prNumber,
        issueNumber: delivered.issueNumber,
        run,
        deps: {
          // The handle the caller gave us, not the process global one. A state
          // directory the caller opened separately would otherwise have its
          // snapshots and outbox written to one database and its claim updated
          // in another.
          db,
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
    } finally {
      // Whatever happened. A timer left running renews a claim for a watch that
      // is no longer there, which is worse than the stale lease it prevents.
      holding.release()
    }
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

/**
 * Watches whose worker went away, described the way a fresh one is.
 *
 * The snapshot is left where it is: the driver restores it, so a resumed watch
 * comes back with whatever it had already established rather than starting from
 * a blank baseline and reporting the pull request's own base as having moved.
 */
function resumable(
  db: Database,
  config: Config,
): { repo: string; issueNumber: number; prNumber: number; branch: string }[] {
  const found: {
    repo: string
    issueNumber: number
    prNumber: number
    branch: string
  }[] = []
  for (const row of abandonedPullRequests(
    db,
    config.staleClaimMinutes * 60_000,
  )) {
    const delivered = deliveredBranch(db, row.repo, row.prNumber)
    if (delivered === undefined || delivered.branch === '') {
      continue
    }
    found.push({
      repo: row.repo,
      issueNumber: delivered.issueNumber,
      prNumber: row.prNumber,
      branch: delivered.branch,
    })
  }
  return found
}
