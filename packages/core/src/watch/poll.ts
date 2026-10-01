import type { Database } from 'bun:sqlite'
import type { Config, WatchedRepo } from '@/config'
import { emit } from '@/events/bus'
import type { GhIssue } from '@/lib/gh'
import { listIssuesSince } from '@/lib/gh'
import { logger } from '@/lib/log'
import { offerRun } from '@/modules/runs/queue'
import { intakePolicyFor, screenIssue } from '@/watch/intake'
import { watchDeliveredPullRequests } from '@/watch/pullRequests'
import { resumeUnfinished } from '@/watch/resume'
import { reviewOpenPullRequests } from '@/watch/reviews'
import { promoteQueued } from '@/watch/scheduler'
import { startQueued } from '@/watch/startRun'
import { completeRun, readCursor, writeCursor } from '@/watch/state'

const log = logger('poll')

/**
 * What the batch cap should be counting.
 *
 * The REST issues endpoint returns pull requests as issues, and the cap exists
 * to limit how much work one pass takes on. Counting pull requests against it
 * lets a busy pull request queue starve the issues: at a cap of one, a single
 * updated pull request means no issue is ever picked up.
 *
 * Only this structural mismatch is filtered. Trust and label screening stays
 * in handleIssue, where a refusal is surfaced rather than silently dropped.
 */
export function workableIssues(issues: readonly GhIssue[]): GhIssue[] {
  return issues.filter(
    (issue) => issue.pull_request === undefined || issue.pull_request === null,
  )
}

/** How far back a first-ever poll looks, so a fresh install does not replay the archive. */
const COLD_START_LOOKBACK_MS = 10 * 60 * 1000

export async function pollOnce(db: Database, config: Config): Promise<number> {
  // Before anything new is claimed. A run whose process went away is still
  // claimed and still has a branch, so picking it up first is what stops a
  // restart looking like an abandoned issue.
  const resumed = await resumeUnfinished(db, config)
  let handled = resumed
  // Started rather than awaited: these run for days and the poller has to keep
  // going. Counted as handled so a pass that only started watches is not
  // reported as having done nothing.
  handled += watchDeliveredPullRequests(db, config)
  // Reviewing what other people opened, started rather than awaited for the same
  // reason: a review can sit on a trust gate for as long as it takes somebody to
  // decide whether to run a stranger's code.
  handled += reviewOpenPullRequests(db, config)
  for (const watched of config.watch) {
    handled += await pollRepo(db, config, watched)
  }
  // Last, so anything offered this pass can be queued and started on the next
  // one rather than waiting a whole poll interval. Started rather than awaited:
  // a run takes minutes and the poller has to keep going.
  void promoteQueued(db, config, (entry) =>
    startQueued(db, config, entry),
  ).catch((error: unknown) => {
    log.error('promotion failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  })
  return handled
}

async function pollRepo(
  db: Database,
  config: Config,
  watched: WatchedRepo,
): Promise<number> {
  const { repo } = watched
  const since =
    readCursor(db, repo) ??
    new Date(Date.now() - COLD_START_LOOKBACK_MS).toISOString()

  // Captured before the request, so anything updated while the request is in
  // flight still falls after the cursor and is seen by the next pass.
  const cutoff = new Date().toISOString()

  let issues: GhIssue[]
  try {
    issues = await listIssuesSince(repo, since)
  } catch (error) {
    log.error('poll failed', {
      repo,
      error: error instanceof Error ? error.message : error,
    })
    return 0
  }

  const candidates = workableIssues(issues)
  const batch = candidates.slice(0, config.maxIssuesPerPoll)
  if (candidates.length > batch.length) {
    log.warn('batch capped, the remainder waits for the next pass', {
      repo,
      matched: candidates.length,
      processing: batch.length,
    })
  }

  const worked = workBatch(db, config, watched, batch)

  // The cursor advances only after the batch has been worked, and only as far
  // as the batch actually reached. Advancing it up front would permanently skip
  // everything still unprocessed if the pass died partway through, and
  // advancing past a failure would put that issue permanently before the next
  // `since`.
  writeCursor(
    db,
    repo,
    nextCursor({
      reachedEnd: batch.length === candidates.length,
      cutoff,
      since,
      lastProcessed: worked.lastProcessed,
      earliestFailure: worked.earliestFailure,
    }),
  )

  return worked.handled
}

interface Worked {
  readonly handled: number
  readonly lastProcessed: GhIssue | undefined
  readonly earliestFailure: GhIssue | undefined
}

/**
 * Works one batch, surviving a throw from any single issue.
 *
 * One issue must never take the tick down with it, or every repository and
 * issue behind it in the pass would go unprocessed.
 */
function workBatch(
  db: Database,
  config: Config,
  watched: WatchedRepo,
  batch: GhIssue[],
): Worked {
  const { repo } = watched
  let handled = 0
  let lastProcessed: GhIssue | undefined
  let earliestFailure: GhIssue | undefined

  for (const issue of batch) {
    try {
      handled += handleIssue(db, config, watched, issue) ? 1 : 0
      lastProcessed = issue
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('issue handling threw', {
        repo,
        issue: issue.number,
        error: message,
      })
      settleFailedRun(db, repo, issue.number, message)
      earliestFailure ??= issue
    }
  }

  return { handled, lastProcessed, earliestFailure }
}

/**
 * Settles a claim that threw, so it cannot sit in `claimed` until its lease
 * expires. Best effort: the cursor hold is what actually matters.
 */
function settleFailedRun(
  db: Database,
  repo: string,
  issue: number,
  error: string,
): void {
  try {
    completeRun(db, repo, issue, { status: 'failed', error })
  } catch {
    // Recording the failure is best effort.
  }
}

interface CursorInput {
  readonly reachedEnd: boolean
  readonly cutoff: string
  readonly since: string
  readonly lastProcessed: GhIssue | undefined
  readonly earliestFailure: GhIssue | undefined
}

/** How far the cursor may advance without stranding an issue behind it. */
function nextCursor(input: CursorInput): string {
  const furthest = input.reachedEnd
    ? input.cutoff
    : (input.lastProcessed?.updated_at ?? input.since)
  if (input.earliestFailure === undefined) return furthest
  return [furthest, input.earliestFailure.updated_at].sort()[0] ?? furthest
}

/**
 * Screens an issue and records that it exists. It does not start anything.
 *
 * This is the change the queue is for. Discovery used to claim and then run the
 * whole pipeline inline, so the number of agents the factory spawned was
 * whatever GitHub happened to return. Now the most a pass can cost is one row
 * per issue, and a person decides what actually runs.
 */
function handleIssue(
  db: Database,
  config: Config,
  watched: WatchedRepo,
  issue: GhIssue,
): boolean {
  const { repo } = watched
  const screening = screenIssue(issue, intakePolicyFor(config, watched))
  if (!screening.accepted) {
    log.debug('issue skipped', {
      repo,
      issue: issue.number,
      reason: screening.reason,
    })
    // Surfaced rather than only logged: a refusal is the trust gate working,
    // and it is worth being able to see it happen.
    emit({
      type: 'gate.refused',
      runId: `${repo}#${issue.number}@refused`,
      repo,
      issue: issue.number,
      reason: screening.reason,
      at: Date.now(),
    })
    return false
  }
  const offered = offerRun(db, {
    repo,
    kind: 'issue',
    number: issue.number,
    title: issue.title,
  })
  if (offered) {
    log.info('offered', { repo, issue: issue.number })
  }
  return offered
}
