import type { Database } from 'bun:sqlite'
import type { Config } from '@/config'
import { getIssue } from '@/lib/gh'
import { listOpenPullRequests } from '@/lib/ghPr'
import { logger } from '@/lib/log'
import type { RunRef, Subject } from '@/modules/work/paths'
import { driveReview } from '@/run/machines/driveReview'
import { intakePolicyFor, screenIssue } from '@/watch/intake'
import { holdReviewClaim } from '@/watch/prClaim'
import { offerRun } from '@/watch/queue'
import {
  claimedPullRequests,
  claimRun,
  completeRun,
  deliveredBranch,
} from '@/watch/state'

const log = logger('review')

/**
 * Starts reviews of pull requests the factory did not open.
 *
 * Started rather than awaited, for the reason the pull request watch learned the
 * hard way: a review can sit on a trust gate for days, and awaiting it here
 * would hold the poller for exactly that long.
 *
 * Q1 still applies. A pull request whose description would not be allowed to
 * start a run is not read either, because the description reaches the reviewer:
 * the title goes in the prompt, and a title is text somebody else wrote.
 */
export function reviewOpenPullRequests(db: Database, config: Config): number {
  let started = 0
  for (const watched of config.watch) {
    void openOnes(db, watched.repo).catch((error: unknown) => {
      log.debug('could not look for pull requests to review', {
        repo: watched.repo,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    started += 1
  }
  return started
}

async function openOnes(db: Database, repo: string): Promise<void> {
  const already = claimedPullRequests(db)
  for (const pr of await listOpenPullRequests(repo)) {
    const key = `${repo}#${pr.number}`
    if (already.has(key)) {
      continue
    }
    // Ours means the factory delivered it, which the claim table knows, rather
    // than our account having opened it. Those are different sets and the
    // difference matters: a maintainer opens pull requests by hand from the same
    // account the factory pushes with, and skipping those would mean the only
    // ones ever reviewed are from accounts that are not this one. Something the
    // factory delivered has already been reviewed by the station that built it,
    // and is kept alive by the other watch.
    if (deliveredBranch(db, repo, pr.number) !== undefined) {
      continue
    }
    // Recorded, not started. This loop is where the flood came from: a
    // repository with thirty open pull requests meant thirty concurrent runs,
    // each one claiming, checking out a stranger's commit and spawning an
    // agent, from a single click on Add.
    offerRun(db, { repo, kind: 'pr', number: pr.number, title: pr.title })
  }
}

export async function startReview(
  db: Database,
  config: Config,
  repo: string,
  prNumber: number,
  title: string,
): Promise<void> {
  const lease = claimRun(
    db,
    repo,
    prNumber,
    config.staleClaimMinutes * 60_000,
    'pr',
  )
  if (lease === null) {
    return
  }
  const subject: Subject = { repo, kind: 'pr', number: prNumber }
  const runId = `${repo}#${prNumber}@${Date.now()}`
  const run: RunRef = { subject, runId }

  try {
    // The same screen an issue passes, on the pull request's own description.
    const asIssue = await getIssue(repo, prNumber)
    const watched = config.watch.find((w) => w.repo === repo)
    const screening = screenIssue(
      { ...asIssue, pull_request: null } as never,
      intakePolicyFor(config, watched ?? { repo }),
    )
    if (!screening.accepted) {
      log.info('not reviewing this, by the same rule that screens an issue', {
        repo,
        pr: prNumber,
        reason: screening.reason,
      })
      completeRun(db, repo, prNumber, { kind: 'pr', status: 'skipped', lease })
      return
    }

    // No checkout of ours at all. The reading half works in a directory with no
    // git repository in it and the running half fetches one commit into a
    // repository of its own, so neither needs a workspace from here. Passing the
    // literal 'HEAD' as a branch name was the first attempt and failed every
    // review before it started, because there is no `refs/heads/HEAD` to fetch.
    const workspace = {
      repo,
      issueNumber: prNumber,
      clonePath: '',
      worktreePath: '',
      branch: '',
      base: '',
    }
    const holding = holdReviewClaim(db, config, repo, prNumber, lease)
    const settled = await driveReview({
      runId,
      repo,
      prNumber,
      title,
      run,
      signal: holding.signal,
      deps: {
        db,
        config,
        issue: asIssue,
        repo,
        workspace,
        run,
        conventionFiles: [],
      },
    })
    holding.release()
    completeRun(db, repo, prNumber, {
      kind: 'pr',
      status: settled.outcome.kind === 'failed' ? 'failed' : 'delivered',
      lease,
      ...(settled.outcome.kind === 'failed'
        ? { error: settled.outcome.error }
        : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('could not review the pull request', {
      repo,
      pr: prNumber,
      error: message,
    })
    completeRun(db, repo, prNumber, {
      kind: 'pr',
      status: 'failed',
      error: message,
      lease,
    })
  }
}
