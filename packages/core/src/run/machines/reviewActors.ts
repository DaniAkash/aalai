import { fromPromise } from 'xstate'
import {
  pullRequestCommits,
  pullRequestDiff,
  pullRequestState,
} from '@/lib/ghPr'
import { logger } from '@/lib/log'
import type { ExecutionVerdict } from '@/run/executionTrust'
import { screenExecution } from '@/run/executionTrust'
import { isReviewable, sizeOf } from '@/run/prSize'
import { runDeps } from './deps'

const log = logger('review')

/**
 * Reads the pull request and decides whether a verdict on it would mean
 * anything, before any agent time is spent.
 */
export const sizer = fromPromise(
  async ({
    input,
  }: {
    input: { runId: string; prNumber: number }
  }): Promise<
    { headSha: string } & (
      | { reviewable: true }
      | { reviewable: false; why: string }
    )
  > => {
    const deps = runDeps(input.runId)
    const pr = await pullRequestState(deps.repo, input.prNumber)
    const diff = await pullRequestDiff(deps.repo, input.prNumber)
    const verdict = isReviewable(sizeOf(diff))
    if (verdict.reviewable) {
      return { headSha: pr.headSha, reviewable: true }
    }
    log.info('declining to review this', {
      pr: input.prNumber,
      because: verdict.reason,
    })
    return {
      headSha: pr.headSha,
      reviewable: false,
      why: `${verdict.reason} ${verdict.suggestion}`,
    }
  },
)

/** Asks whether the code on this head may run without anybody being asked. */
export const executionScreen = fromPromise(
  async ({
    input,
  }: {
    input: { runId: string; prNumber: number }
  }): Promise<ExecutionVerdict> => {
    const deps = runDeps(input.runId)
    return screenExecution(deps.repo, input.prNumber)
  },
)

/**
 * Reads the change and says what it thinks, without running it.
 *
 * The diff arrives as text and there is no checkout of the contributor's branch
 * anywhere. That is what makes this safe rather than the permission mode, which
 * `scripts/permission-probe.ts` established prevents nothing.
 */
export const staticReviewer = fromPromise(
  async ({
    input,
    signal,
  }: {
    input: { runId: string; prNumber: number; title: string; willRun: boolean }
    signal: AbortSignal
  }): Promise<void> => {
    const deps = runDeps(input.runId)
    const [diff, commits] = await Promise.all([
      pullRequestDiff(deps.repo, input.prNumber),
      pullRequestCommits(deps.repo, input.prNumber),
    ])
    const { runStaticReview } = await import('@/run/stations/review')
    await runStaticReview({
      runId: input.runId,
      repo: deps.repo,
      prNumber: input.prNumber,
      title: input.title,
      diff,
      authors: [...new Set(commits.map((c) => c.authorLogin ?? c.authorName))],
      willRun: input.willRun,
      // Our own checkout of our own default branch, which is where the review
      // reads from. The contributor's code is in the prompt and nowhere else.
      worktree: deps.workspace.worktreePath,
      config: deps.config,
      signal,
    })
    log.info('read the change without running it', { pr: input.prNumber })
  },
)

/** Notices the head moving, which makes anything already read stale. */
export const headWatch = fromPromise(
  async ({
    input,
  }: {
    input: { runId: string; prNumber: number; headSha: string }
  }): Promise<{
    moved: boolean
    headSha: string
    headRef: string
    state: string
  }> => {
    const deps = runDeps(input.runId)
    const pr = await pullRequestState(deps.repo, input.prNumber)
    return {
      moved: pr.headSha !== input.headSha,
      headSha: pr.headSha,
      // Carried out of here because the only thing that checks anything out
      // reads it, and it should use the branch this check just looked at rather
      // than asking again and possibly getting a different answer.
      headRef: pr.headRef,
      state: pr.state,
    }
  },
)

export interface RanTests {
  readonly ran: boolean
  readonly passed: boolean
  /** What happened, trimmed, for the verdict to quote. */
  readonly output: string
  readonly why?: string
}

/**
 * Checks out the branch and runs its tests.
 *
 * The only place in this machine that puts somebody else's code on disk, and it
 * is reachable exactly two ways: the authors are trusted, or a person answered a
 * gate that said in plain words that approving it runs this code on their
 * machine. Everything upstream of here exists to make sure one of those is true.
 *
 * The checkout is thrown away afterwards whatever happened, because a branch
 * left lying around is a branch something else might wander into.
 */
export const dynamicReviewer = fromPromise(
  async ({
    input,
  }: {
    input: { runId: string; prNumber: number; headRef: string }
  }): Promise<RanTests> => {
    const deps = runDeps(input.runId)
    const { addBranchWorktree, removeWorktree } = await import(
      '@/lib/gitWorktree'
    )
    const { findTestCommand } = await import('@/run/testCommand')
    const { exec } = await import('@/lib/proc')
    const { join } = await import('node:path')

    const checkout = join(
      deps.workspace.clonePath,
      '..',
      `review-pr-${input.prNumber}`,
    )
    await removeWorktree(deps.workspace.clonePath, checkout)
    await addBranchWorktree(deps.workspace.clonePath, checkout, input.headRef)
    try {
      const found = await findTestCommand(checkout)
      if (!found.found) {
        log.info('not running anything, because nothing said how', {
          pr: input.prNumber,
          why: found.why,
        })
        return { ran: false, passed: false, output: '', why: found.why }
      }
      log.info('running the tests on this branch', {
        pr: input.prNumber,
        how: found.command.how,
      })
      const result = await exec([...found.command.argv], { cwd: checkout })
      const output = `${result.stdout}\n${result.stderr}`.trim()
      return {
        ran: true,
        passed: result.exitCode === 0,
        output: output.split('\n').slice(-60).join('\n'),
      }
    } finally {
      // Whatever happened. Somebody else's checkout is not something to leave
      // sitting next to our own.
      await removeWorktree(deps.workspace.clonePath, checkout)
    }
  },
)
