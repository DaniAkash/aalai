import type { Database } from 'bun:sqlite'
import type { Config } from '@/config'
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

  let issues
  try {
    issues = await listIssuesSince(repo, since)
  } catch (error) {
    log.error('poll failed', { repo, error: error instanceof Error ? error.message : error })
    return 0
  }

  // The cursor advances on every successful poll, whether or not anything was
  // actionable. Re-screening the same rejected issue forever wastes API quota,
  // and the claim table, not the cursor, is what prevents a duplicate run.
  writeCursor(db, repo, new Date().toISOString())

  const policy = {
    trustedAuthorsOnly: config.trustedAuthorsOnly,
    requireLabel: config.requireLabel,
  }

  let handled = 0
  for (const issue of issues) {
    const screening = screenIssue(issue, policy)
    if (!screening.accepted) {
      log.debug('issue skipped', { repo, issue: issue.number, reason: screening.reason })
      continue
    }
    if (!claimRun(db, repo, issue.number)) {
      log.debug('already claimed', { repo, issue: issue.number })
      continue
    }

    const result = await runIssue(repo, issue, config)
    completeRun(db, repo, issue.number, {
      status: result.status,
      branch: result.branch,
      prUrl: result.prUrl,
      error: result.error,
    })
    log.info('run finished', { repo, issue: issue.number, status: result.status })
    handled += 1
  }
  return handled
}
