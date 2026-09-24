import type { Config } from '@/config'
import { emit, registerRunRoot } from '@/events/bus'
import type { GhIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import { redactDeep } from '@/lib/redact'
import type { RunRef, Subject } from '@/modules/work/paths'
import {
  recordAnalysis,
  recordReview,
  recordRun,
  snapshotOf,
} from '@/run/artifacts'
import { commitImplementerWork } from '@/run/commit'
import { detectConventions } from '@/run/conventions'
import { type Delivery, deliver, reportOutcomeOnIssue } from '@/run/deliver'
import { runReviewLoop } from '@/run/loop'
import { runAnalyst, runImplementer, runReviewer } from '@/run/stations'
import {
  discardPath,
  discardWorkspace,
  prepareReviewWorkspace,
  prepareWorkspace,
  type Workspace,
} from '@/run/workspace'

const log = logger('pipeline')

/**
 * Artifacts are written best effort.
 *
 * A run that produced a pull request has done its job, and a full disk or a
 * permission problem under the work directory is not a reason to throw that
 * away. The failure is logged loudly rather than swallowed quietly.
 */
async function record(
  what: string,
  write: () => Promise<unknown>,
): Promise<void> {
  try {
    await write()
  } catch (error) {
    log.error('could not write artifacts', {
      what,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export interface PipelineResult {
  readonly status: 'delivered' | 'skipped' | 'failed'
  readonly branch?: string
  readonly prUrl?: string
  readonly error?: string
}

/**
 * Takes one issue from intake to a draft pull request, through four stations.
 *
 *   analyst    plans, writes the acceptance criteria, modifies nothing
 *   implementer writes the code against that plan
 *   reviewer   judges the committed diff from its own checkout
 *   delivery   pushes and opens a draft, only on an approved verdict
 *
 * Every stage resolves to a `PipelineResult` rather than throwing, because the
 * caller finalises the run's claim from that result: a rejection here would
 * leave the issue claimed and unretryable until its lease expires.
 */
export async function runIssue(
  repo: string,
  issue: GhIssue,
  config: Config,
): Promise<PipelineResult> {
  const runId = `${repo}#${issue.number}@${Date.now()}`
  const subject: Subject = { repo, kind: 'issue', number: issue.number }
  const run: RunRef = { subject, runId }
  log.info('run starting', { repo, issue: issue.number, title: issue.title })
  emit({
    type: 'run.started',
    runId,
    repo,
    issue: issue.number,
    title: issue.title,
    at: Date.now(),
  })
  emit({ type: 'stage.entered', runId, stage: 'workspace', at: Date.now() })

  let workspace: Workspace
  try {
    workspace = await prepareWorkspace(repo, issue.number, issue.title)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('workspace setup failed', {
      repo,
      issue: issue.number,
      error: message,
    })
    emit({
      type: 'run.failed',
      runId,
      error: `workspace setup failed: ${message}`,
      at: Date.now(),
    })
    // This return is before the try below, so it never reaches that finally.
    // Recorded here instead: a run that failed before it had a workspace is
    // still a run, and its outcome is the only thing left of it.
    const failed: PipelineResult = {
      status: 'failed',
      error: `workspace setup failed: ${message}`,
    }
    await record('run', () =>
      recordRun(run, snapshotOf(runId, repo, issue.number, failed)),
    )
    return failed
  }

  let reviewWorktree: string | null = null
  let delivered = false
  let result: PipelineResult = { status: 'failed', error: 'run did not finish' }

  try {
    // From here on every event is redacted against this worktree before it
    // leaves the bus.
    registerRunRoot(runId, workspace.worktreePath)

    const conventionFiles = await detectConventions(workspace.worktreePath)
    log.info('conventions detected', {
      files: conventionFiles.length === 0 ? 'none' : conventionFiles.join(','),
    })
    emit({
      type: 'workspace.ready',
      runId,
      branch: workspace.branch,
      base: workspace.base,
      conventions: conventionFiles,
      at: Date.now(),
    })
    emit({ type: 'stage.entered', runId, stage: 'analyst', at: Date.now() })

    const { analysis } = await runAnalyst({
      runId,
      repo,
      issue,
      worktree: workspace.worktreePath,
      conventionFiles,
      config,
    })
    log.info('plan ready', {
      steps: analysis.plan.length,
      criteria: analysis.acceptance_criteria.length,
    })
    emit({
      type: 'analysis.ready',
      runId,
      steps: analysis.plan.length,
      criteria: analysis.acceptance_criteria,
      at: Date.now(),
    })
    await record('analysis', () =>
      recordAnalysis(subject, run, issue, analysis),
    )

    const outcome = await runReviewLoop(
      {
        implement: async (revision) => {
          emit({
            type: 'stage.entered',
            runId,
            stage: 'implementer',
            at: Date.now(),
          })
          if (revision !== undefined) {
            emit({
              type: 'revision.started',
              runId,
              attempt: revision.attempt,
              findings: revision.review.blocking_findings,
              at: Date.now(),
            })
          }
          const turn = await runImplementer({
            runId,
            repo,
            issue,
            worktree: workspace.worktreePath,
            analysis,
            conventionFiles,
            revision,
            config,
          })
          return turn.text
        },
        commit: (attempt) =>
          commitImplementerWork(runId, workspace, issue, attempt, config),
        review: async () => {
          emit({
            type: 'stage.entered',
            runId,
            stage: 'reviewer',
            at: Date.now(),
          })
          const path = await prepareReviewWorkspace(workspace)
          reviewWorktree = path
          const { review } = await runReviewer({
            runId,
            repo,
            issue,
            worktree: path,
            analysis,
            base: workspace.base,
            branch: workspace.branch,
            config,
          })
          // Redacted at the boundary: every field below is published, either in
          // the pull request body or in an issue comment on a stopped run.
          const safe = redactDeep(review, workspace.worktreePath)
          emit({
            type: 'review.verdict',
            runId,
            verdict: safe.verdict,
            results: safe.criteria_results,
            at: Date.now(),
          })
          await record('review', () => recordReview(subject, run, issue, safe))
          return safe
        },
      },
      analysis,
      config,
    )

    if (outcome.kind === 'stopped') {
      emit({
        type: 'run.stopped',
        runId,
        reason: outcome.reason,
        at: Date.now(),
      })
      await reportOutcomeOnIssue(repo, issue, {
        delivered: false,
        reason: outcome.reason,
      })
      result = { status: 'skipped', error: outcome.reason }
      return result
    }

    emit({ type: 'stage.entered', runId, stage: 'deliver', at: Date.now() })

    const delivery: Delivery = await deliver({
      workspace,
      issue,
      analysis,
      review: outcome.review,
      report: outcome.implementerReport,
      config,
    })
    await reportOutcomeOnIssue(repo, issue, delivery)

    if (!delivery.delivered) {
      emit({
        type: 'run.stopped',
        runId,
        reason: delivery.reason,
        at: Date.now(),
      })
      result = { status: 'skipped', error: delivery.reason }
      return result
    }
    emit({
      type: 'run.delivered',
      runId,
      prUrl: delivery.prUrl,
      branch: delivery.branch,
      at: Date.now(),
    })
    delivered = true
    result = {
      status: 'delivered',
      branch: delivery.branch,
      prUrl: delivery.prUrl,
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('run failed', { repo, issue: issue.number, error: message })
    emit({ type: 'run.failed', runId, error: message, at: Date.now() })
    result = { status: 'failed', error: message }
    return result
  } finally {
    await record('run', () =>
      recordRun(run, snapshotOf(runId, repo, issue.number, result)),
    )
    if (reviewWorktree !== null) {
      await discardPath(workspace, reviewWorktree)
    }
    // keepWorktreeOnFailure is exactly that: a successful run always cleans up,
    // or every delivered issue leaves a checkout and a branch behind.
    if (delivered || !config.keepWorktreeOnFailure) {
      await discardWorkspace(workspace)
    }
  }
}
