import type { Database } from 'bun:sqlite'
import type { Config } from '@/config'
import { getIssue } from '@/lib/gh'
import { listOpenPullRequests } from '@/lib/ghPr'
import { logger } from '@/lib/log'
import type { RunRef, Subject } from '@/modules/work/paths'
import { driveReview } from '@/run/machines/driveReview'
import { reviveWorkspace } from '@/run/workspace'
import { intakePolicyFor, screenIssue } from '@/watch/intake'
import { claimedPullRequests, claimRun, completeRun } from '@/watch/state'

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
    void openOnes(db, config, watched.repo).catch((error: unknown) => {
      log.debug('could not look for pull requests to review', {
        repo: watched.repo,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    started += 1
  }
  return started
}

const inFlight = new Set<string>()

async function openOnes(
  db: Database,
  config: Config,
  repo: string,
): Promise<void> {
  const already = claimedPullRequests(db)
  for (const pr of await listOpenPullRequests(repo)) {
    const key = `${repo}#${pr.number}`
    if (already.has(key) || inFlight.has(key)) {
      continue
    }
    // Ours is somebody else's problem, specifically the pull request watch's.
    // Reviewing our own change is what the reviewer station already did before
    // it was delivered.
    if (pr.openedByUs) {
      continue
    }
    inFlight.add(key)
    void start(db, config, repo, pr.number, pr.title).finally(() => {
      inFlight.delete(key)
    })
  }
}

async function start(
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

    // Our own default branch. The contributor's code is never checked out for
    // the reading half, and the running half makes its own throwaway checkout.
    const workspace = await reviveWorkspace(repo, prNumber, title, 'HEAD')
    const settled = await driveReview({
      runId,
      repo,
      prNumber,
      title,
      run,
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
