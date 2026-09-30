import type { Database } from 'bun:sqlite'
import type { Config } from '@/config'
import type { GhIssue } from '@/lib/gh'
import { getIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import { getDb } from '@/modules/db/db'
import type { RunRef, Subject } from '@/modules/work/paths'
import { drivePullRequest } from '@/run/machines/drivePr'
import type { PipelineResult } from '@/run/pipeline'
import { keepsPullRequestsAlive } from '@/run/policy'
import { reviveWorkspace } from '@/run/workspace'
import {
  claimRun,
  completeRun,
  deliveredPullRequests,
  renewClaim,
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
  for (const delivered of deliveredPullRequests(db)) {
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
    // Renewed while the watch runs. The lease exists so a killed process does
    // not hold a subject forever, and a watch measured in days would otherwise
    // look abandoned long before it was.
    const heartbeat = setInterval(
      () => {
        if (!renewClaim(db, delivered.repo, delivered.prNumber, lease, 'pr')) {
          log.warn('this watch no longer holds its claim', {
            repo: delivered.repo,
            pr: delivered.prNumber,
          })
        }
      },
      Math.max(60_000, (config.staleClaimMinutes * 60_000) / 3),
    )

    try {
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
    } finally {
      // Whatever happened. A timer left running holds a claim alive for a watch
      // that is no longer there, which is worse than the stale lease it exists
      // to prevent.
      clearInterval(heartbeat)
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
 * Picks a pull request watch back up where a killed process left it.
 *
 * The snapshot goes into the machine that wrote it. Its own branch is where the
 * work is, so the checkout is rebuilt from the branch the same way a fresh watch
 * builds one, and the machine restores whatever it had already established
 * rather than starting from a blank baseline and reporting the base as moved.
 */
export async function resumePullRequest(input: {
  db: Database
  config: Config
  repo: string
  prNumber: number
  issue: GhIssue
  run: RunRef
  runId: string
  snapshot: unknown
}): Promise<PipelineResult> {
  const branch = branchOf(input.db, input.repo, input.prNumber)
  const workspace = await reviveWorkspace(
    input.repo,
    input.issue.number,
    input.issue.title,
    branch,
  )
  const settled = await drivePullRequest({
    runId: input.runId,
    repo: input.repo,
    prNumber: input.prNumber,
    issueNumber: input.issue.number,
    run: input.run,
    snapshot: input.snapshot,
    deps: {
      db: input.db,
      config: input.config,
      issue: input.issue,
      repo: input.repo,
      workspace,
      run: input.run,
      conventionFiles: [],
    },
  })
  return settled.outcome.kind === 'failed'
    ? { status: 'failed', error: settled.outcome.error }
    : { status: 'delivered', branch }
}

/** The branch a delivered pull request was built on, recorded by its issue's run. */
function branchOf(db: Database, repo: string, prNumber: number): string {
  const found = deliveredPullRequests(db).find(
    (row) => row.repo === repo && row.prNumber === prNumber,
  )
  return found?.branch ?? ''
}
