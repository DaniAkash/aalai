import type { Config } from '@/config'
import type { GhIssue } from '@/lib/gh'
import * as git from '@/lib/git'
import { logger } from '@/lib/log'
import { buildCommitMessage } from '@/prompts/implement-issue'
import { conventionsInstruction, detectConventions } from '@/run/conventions'
import { deliver, reportOutcomeOnIssue, type Delivery } from '@/run/deliver'
import { emit, registerRunRoot } from '@/events/bus'
import { redactDeep } from '@/lib/redact'
import { runReviewLoop, type CommitOutcome } from '@/run/loop'
import { runAnalyst, runImplementer, runReviewer } from '@/run/stations'
import type { Analysis } from '@/run/stations/schemas'
import {
  discardPath,
  discardWorkspace,
  prepareReviewWorkspace,
  prepareWorkspace,
  type Workspace,
} from '@/run/workspace'

const log = logger('pipeline')

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
  log.info('run starting', { repo, issue: issue.number, title: issue.title })
  emit({ type: 'run.started', runId, repo, issue: issue.number, title: issue.title, at: Date.now() })
  emit({ type: 'stage.entered', runId, stage: 'workspace', at: Date.now() })

  let workspace: Workspace
  try {
    workspace = await prepareWorkspace(repo, issue.number, issue.title)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('workspace setup failed', { repo, issue: issue.number, error: message })
    emit({ type: 'run.failed', runId, error: `workspace setup failed: ${message}`, at: Date.now() })
    return { status: 'failed', error: `workspace setup failed: ${message}` }
  }

  let reviewWorktree: string | null = null
  let delivered = false

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

    const outcome = await runReviewLoop(
      {
        implement: async (revision) => {
          emit({ type: 'stage.entered', runId, stage: 'implementer', at: Date.now() })
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
        commit: (attempt) => commitImplementerWork(runId, workspace, issue, attempt, config),
        review: async () => {
          emit({ type: 'stage.entered', runId, stage: 'reviewer', at: Date.now() })
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
          return safe
        },
      },
      analysis,
      config,
    )

    if (outcome.kind === 'stopped') {
      emit({ type: 'run.stopped', runId, reason: outcome.reason, at: Date.now() })
      await reportOutcomeOnIssue(repo, issue, { delivered: false, reason: outcome.reason })
      return { status: 'skipped', error: outcome.reason }
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
      emit({ type: 'run.stopped', runId, reason: delivery.reason, at: Date.now() })
      return { status: 'skipped', error: delivery.reason }
    }
    emit({
      type: 'run.delivered',
      runId,
      prUrl: delivery.prUrl,
      branch: delivery.branch,
      at: Date.now(),
    })
    delivered = true
    return { status: 'delivered', branch: delivery.branch, prUrl: delivery.prUrl }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('run failed', { repo, issue: issue.number, error: message })
    emit({ type: 'run.failed', runId, error: message, at: Date.now() })
    return { status: 'failed', error: message }
  } finally {
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

/** Stages the implementer's work and commits it locally, unpushed. */
async function commitImplementerWork(
  runId: string,
  workspace: Workspace,
  issue: GhIssue,
  attempt: number,
  config: Config,
): Promise<CommitOutcome> {
  const changed = await git.changedFiles(workspace.worktreePath)
  const { deliverable, generated } = git.partitionStagePaths(changed)
  if (generated.length > 0) {
    log.warn('ignoring generated output the agent produced', { count: generated.length })
  }
  if (deliverable.length === 0) {
    return 'no-changes'
  }

  await git.stageAll(workspace.worktreePath)
  if (!(await git.hasStagedChanges(workspace.worktreePath))) {
    return 'generated-only'
  }

  const subject = buildCommitMessage(issue).split('\n')[0] ?? issue.title
  const sha = await git.commit(
    workspace.worktreePath,
    attempt === 0 ? buildCommitMessage(issue) : `${subject} (review pass ${attempt})`,
    { name: config.commitName, email: config.commitEmail },
  )
  log.info('committed locally', { sha: sha.slice(0, 8), attempt })
  emit({ type: 'commit.made', runId, sha, attempt, at: Date.now() })
  return 'committed'
}
