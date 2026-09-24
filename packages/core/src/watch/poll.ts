import type { Database } from 'bun:sqlite'
import type { Config, WatchedRepo } from '@/config'
import { emit } from '@/events/bus'
import type { GhIssue } from '@/lib/gh'
import { listIssuesSince } from '@/lib/gh'
import { logger } from '@/lib/log'
import { runIssue } from '@/run/pipeline'
import { intakePolicyFor, screenIssue } from '@/watch/intake'
import { claimRun, completeRun, readCursor, writeCursor } from '@/watch/state'

const log = logger('poll')

/** How far back a first-ever poll looks, so a fresh install does not replay the archive. */
const COLD_START_LOOKBACK_MS = 10 * 60 * 1000

export async function pollOnce(db: Database, config: Config): Promise<number> {
  let handled = 0
  for (const watched of config.watch) {
    handled += await pollRepo(db, config, watched)
  }
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

  const batch = issues.slice(0, config.maxIssuesPerPoll)
  if (issues.length > batch.length) {
    log.warn('batch capped, the remainder waits for the next pass', {
      repo,
      matched: issues.length,
      processing: batch.length,
    })
  }

  const worked = await workBatch(db, config, watched, batch)

  // The cursor advances only after the batch has been worked, and only as far
  // as the batch actually reached. Advancing it up front would permanently skip
  // everything still unprocessed if the pass died partway through, and
  // advancing past a failure would put that issue permanently before the next
  // `since`.
  writeCursor(
    db,
    repo,
    nextCursor({
      reachedEnd: batch.length === issues.length,
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
async function workBatch(
  db: Database,
  config: Config,
  watched: WatchedRepo,
  batch: GhIssue[],
): Promise<Worked> {
  const { repo } = watched
  let handled = 0
  let lastProcessed: GhIssue | undefined
  let earliestFailure: GhIssue | undefined

  for (const issue of batch) {
    try {
      handled += (await handleIssue(db, config, watched, issue)) ? 1 : 0
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

async function handleIssue(
  db: Database,
  config: Config,
  watched: WatchedRepo,
  issue: GhIssue,
): Promise<boolean> {
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
  const lease = claimRun(
    db,
    repo,
    issue.number,
    config.staleClaimMinutes * 60_000,
  )
  if (lease === null) {
    log.debug('already claimed', { repo, issue: issue.number })
    return false
  }

  const result = await runIssue(repo, issue, config)
  const recorded = completeRun(db, repo, issue.number, {
    status: result.status,
    branch: result.branch,
    prUrl: result.prUrl,
    error: result.error,
    lease,
  })
  if (!recorded) {
    // The lease expired and another pass took the issue over mid-run.
    log.warn('result discarded, the claim was taken over', {
      repo,
      issue: issue.number,
    })
  }
  log.info('run finished', { repo, issue: issue.number, status: result.status })
  return true
}
