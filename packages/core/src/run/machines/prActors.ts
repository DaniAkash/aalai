import { fromPromise } from 'xstate'
import { failedLog, latestWorkflowRunId, pullRequestState } from '@/lib/ghPr'
import { diffNames, diffStat, headSha, pushBranch } from '@/lib/git'
import { logger } from '@/lib/log'
import { commitImplementerWork } from '@/run/commit'
import { runCiFixer, runFaultClassifier } from '@/run/stations/fault'
import type { FaultVerdict } from '@/run/stations/schemas'
import { runDeps } from './deps'

const log = logger('pr')

/**
 * Asks whether a failing check is this change's fault.
 *
 * Its evidence is fetched here rather than carried through the machine because
 * a log is large, changes, and has no business sitting in a snapshot that gets
 * written on every transition.
 */
export const faultClassifier = fromPromise(
  async ({
    input,
    signal,
  }: {
    input: { runId: string; prNumber: number; failing: readonly string[] }
    signal: AbortSignal
  }): Promise<FaultVerdict> => {
    const deps = runDeps(input.runId)
    const pr = await pullRequestState(deps.repo, input.prNumber)
    const runId = await latestWorkflowRunId(deps.repo, pr.headRef)
    const evidence =
      runId === undefined ? '' : await failedLog(deps.repo, runId, 120)
    const { verdict } = await runFaultClassifier({
      runId: input.runId,
      repo: deps.repo,
      prNumber: input.prNumber,
      failing: input.failing,
      log: evidence,
      // A stat and the file names rather than the whole diff. The question is
      // whether the failure names something this change touched, which a list
      // of touched things answers, and a full diff of a large change would be
      // most of the prompt for no extra signal.
      diff: await changeSummary(deps),
      worktree: deps.workspace.worktreePath,
      config: deps.config,
      signal,
    })
    log.info('decided whose fault the checks are', {
      pr: input.prNumber,
      fault: verdict.fault,
    })
    return verdict
  },
)

/**
 * Says that a failure was not caused by this change.
 *
 * Posted rather than kept, because silence on a red pull request reads as
 * nobody having looked at it, and the next person to read it would start by
 * working out what this already knows.
 */
export const failureReporter = fromPromise(
  async ({
    input,
  }: {
    input: { runId: string; prNumber: number; verdict: FaultVerdict }
  }): Promise<void> => {
    const deps = runDeps(input.runId)
    const body = [
      `The checks are failing for something this change does not appear to have caused: ${input.verdict.summary}`,
      '',
      input.verdict.reasoning,
      '',
      'Nothing has been changed on the branch. If that reading is wrong, say so here and it will be looked at again.',
    ].join('\n')
    await queueComment(deps, input.prNumber, body)
  },
)

/** What this change touched, small enough to sit beside a log in one prompt. */
async function changeSummary(
  deps: ReturnType<typeof runDeps>,
): Promise<string> {
  const [stat, names] = await Promise.all([
    diffStat(deps.workspace.worktreePath, deps.workspace.base),
    diffNames(deps.workspace.worktreePath, deps.workspace.base),
  ])
  return [stat.trim(), '', 'files changed:', ...names].join('\n')
}

/** Queues a comment the way every other outbound thing is queued. */
async function queueComment(
  deps: ReturnType<typeof runDeps>,
  prNumber: number,
  body: string,
): Promise<void> {
  const { queueOutbound } = await import('@/modules/work/store')
  await queueOutbound(deps.run, {
    kind: 'comment_on_issue',
    body,
    station: 'reviewer',
    queuedAt: new Date().toISOString(),
  })
  log.info('queued a note on the pull request', { pr: prNumber })
}

/**
 * Fixes a failing check, commits it and pushes.
 *
 * Returns the commit it pushed, which is how the watch tells its own push from
 * a person's: a head this run did not put there belongs to somebody else.
 *
 * A turn that changes nothing is not a success. The agent is allowed to say it
 * cannot see the fix, and that has to end the attempt rather than push an empty
 * commit and wait for the same check to fail the same way.
 */
export const ciFixer = fromPromise(
  async ({
    input,
    signal,
  }: {
    input: {
      runId: string
      prNumber: number
      failing: readonly string[]
      why: string
      attempt: number
    }
    signal: AbortSignal
  }): Promise<{ pushedSha: string }> => {
    const deps = runDeps(input.runId)
    const pr = await pullRequestState(deps.repo, input.prNumber)
    const workflowRun = await latestWorkflowRunId(deps.repo, pr.headRef)
    const evidence =
      workflowRun === undefined
        ? ''
        : await failedLog(deps.repo, workflowRun, 160)

    await runCiFixer({
      runId: input.runId,
      repo: deps.repo,
      prNumber: input.prNumber,
      failing: input.failing,
      log: evidence,
      why: input.why,
      attempt: input.attempt,
      worktree: deps.workspace.worktreePath,
      config: deps.config,
      signal,
    })

    const outcome = await commitImplementerWork(
      deps.run.runId,
      deps.workspace,
      deps.issue,
      input.attempt + 1,
      deps.config,
    )
    if (outcome !== 'committed') {
      throw new Error(`the fix changed nothing (${outcome})`)
    }

    await pushBranch(deps.workspace.worktreePath, deps.workspace.branch)
    const pushed = await headSha(deps.workspace.worktreePath)
    log.info('pushed a fix for the failing checks', {
      pr: input.prNumber,
      sha: (pushed ?? '').slice(0, 8),
    })
    return { pushedSha: pushed ?? '' }
  },
)
