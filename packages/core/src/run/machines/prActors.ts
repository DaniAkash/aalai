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
    await sayOnPullRequest(deps, input.prNumber, body)
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

/**
 * Queues a note and sends it.
 *
 * Queued and then drained in the same breath, unlike everything triage queues.
 * The gate exists because a station's words about a stranger's issue need a
 * person's release before they are said in public. This is different in the way
 * that matters: the pull request is the factory's own, the note says only that a
 * failure was not caused by this change, and there is no gate on this run for an
 * intent to wait behind. Queueing it and leaving it was the first version, and
 * it meant the promised note was never posted anywhere at all.
 */
async function sayOnPullRequest(
  deps: ReturnType<typeof runDeps>,
  prNumber: number,
  body: string,
): Promise<void> {
  const { queueOutbound } = await import('@/modules/work/store')
  const { deliverOutbox } = await import('@/modules/outbound/deliver')
  const at = new Date().toISOString()
  await queueOutbound(
    deps.run,
    {
      kind: 'comment_on_issue',
      body,
      station: 'reviewer',
      queuedAt: at,
      // Released by the run itself. Nothing here is a station speaking for the
      // maintainer about somebody else's issue.
      gateId: SELF_RELEASED,
    },
    `pr-${prNumber}-not-ours`,
  )
  const report = await deliverOutbox({
    db: deps.db,
    run: deps.run,
    // The pull request, not the issue that produced it. Sending this to the
    // issue would put a note about a failing check on a thread that was closed
    // when the pull request opened.
    repo: deps.repo,
    issueNumber: prNumber,
    released: SELF_RELEASED,
  })
  if (report.delivered.length === 0) {
    throw new Error('the note about the failing checks could not be posted')
  }
  log.info('said on the pull request that the failure was not ours', {
    pr: prNumber,
  })
}

/**
 * The gate id standing for "this run released it itself".
 *
 * Delivery refuses anything naming no gate, which is the property that keeps a
 * station from posting. A run that is allowed to speak for itself still has to
 * name something, and naming a sentinel keeps that rule one rule rather than
 * two.
 */
const SELF_RELEASED = 'self:pr-lifecycle'

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
