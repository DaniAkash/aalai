import type { Database } from 'bun:sqlite'
import type { Config } from '@/config'
import { emit } from '@/events/bus'
import type { GhIssue } from '@/lib/gh'
import { listIssuesSince } from '@/lib/gh'
import { logger } from '@/lib/log'
import { runIssue } from '@/run/pipeline'
import { screenIssue } from '@/watch/intake'
import { claimRun, completeRun, readCursor, writeCursor } from '@/watch/state'

const log = logger('poll')

/** How far back a first-ever poll looks, so a fresh install does not replay the archive. */
const COLD_START_LOOKBACK_MS = 10 * 60 * 1000

export async function pollOnce(db: Database, config: Config): Promise<number> {
  let handled = 0
  for (const watched of config.watch) {
    handled += await pollRepo(db, config, watched.repo)
  }
  return handled
}

async function pollRepo(db: Database, config: Config, repo: string): Promise<number> {
  const since =
    readCursor(db, repo) ?? new Date(Date.now() - COLD_START_LOOKBACK_MS).toISOString()

  // Captured before the request, so anything updated while the request is in
  // flight still falls after the cursor and is seen by the next pass.
  const cutoff = new Date().toISOString()

  let issues: GhIssue[]
  try {
    issues = await listIssuesSince(repo, since)
  } catch (error) {
    log.error('poll failed', { repo, error: error instanceof Error ? error.message : error })
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

  let handled = 0
  let lastProcessed: GhIssue | undefined
  let earliestFailure: GhIssue | undefined

  for (const issue of batch) {
    try {
      handled += (await handleIssue(db, config, repo, issue)) ? 1 : 0
      lastProcessed = issue
    } catch (error) {
      // One issue must never take the tick down with it, or every repository
      // and issue behind it in the pass would go unprocessed.
      const message = error instanceof Error ? error.message : String(error)
      log.error('issue handling threw', { repo, issue: issue.number, error: message })
      // Settle the claim so it cannot sit in `claimed` until its lease expires,
      // and hold the cursor at this issue so the next pass still sees it.
      try {
        completeRun(db, repo, issue.number, { status: 'failed', error: message })
      } catch {
        // Recording the failure is best effort; the cursor hold is what matters.
      }
      earliestFailure ??= issue
    }
  }

  // The cursor advances only after the batch has been worked, and only as far as
  // the batch actually reached. Advancing it up front would permanently skip
  // everything still unprocessed if the pass died partway through, and advancing
  // past a failure would put that issue permanently before the next `since`.
  const reachedEnd = batch.length === issues.length
  const furthest = reachedEnd ? cutoff : (lastProcessed?.updated_at ?? since)
  const next =
    earliestFailure === undefined
      ? furthest
      : [furthest, earliestFailure.updated_at].sort()[0] ?? furthest
  writeCursor(db, repo, next)

  return handled
}

async function handleIssue(
  db: Database,
  config: Config,
  repo: string,
  issue: GhIssue,
): Promise<boolean> {
  const screening = screenIssue(issue, {
    trustedAuthorsOnly: config.trustedAuthorsOnly,
    requireLabel: config.requireLabel,
  })
  if (!screening.accepted) {
    log.debug('issue skipped', { repo, issue: issue.number, reason: screening.reason })
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
  const lease = claimRun(db, repo, issue.number, config.staleClaimMinutes * 60_000)
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
    log.warn('result discarded, the claim was taken over', { repo, issue: issue.number })
  }
  log.info('run finished', { repo, issue: issue.number, status: result.status })
  return true
}
