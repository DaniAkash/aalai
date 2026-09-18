import type { Config } from '@/config'
import type { GhIssue } from '@/lib/gh'
import * as git from '@/lib/git'
import { logger } from '@/lib/log'
import { buildCommitMessage } from '@/prompts/implement-issue'
import { conventionsInstruction, detectConventions } from '@/run/conventions'
import { deliver, reportOutcomeOnIssue, type Delivery } from '@/run/deliver'
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
  log.info('run starting', { repo, issue: issue.number, title: issue.title })

  let workspace: Workspace
  try {
    workspace = await prepareWorkspace(repo, issue.number, issue.title)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('workspace setup failed', { repo, issue: issue.number, error: message })
    return { status: 'failed', error: `workspace setup failed: ${message}` }
  }

  let reviewWorktree: string | null = null
  let delivered = false

  try {
    const conventionFiles = await detectConventions(workspace.worktreePath)
    log.info('conventions detected', {
      files: conventionFiles.length === 0 ? 'none' : conventionFiles.join(','),
    })

    const { analysis } = await runAnalyst({
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

    const outcome = await runReviewLoop(
      {
        implement: async (revision) => {
          const turn = await runImplementer({
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
        commit: (attempt) => commitImplementerWork(workspace, issue, attempt, config),
        review: async () => {
          const path = await prepareReviewWorkspace(workspace)
          reviewWorktree = path
          const { review } = await runReviewer({
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
          return redactDeep(review, workspace.worktreePath)
        },
      },
      analysis,
      config,
    )

    if (outcome.kind === 'stopped') {
      await reportOutcomeOnIssue(repo, issue, { delivered: false, reason: outcome.reason })
      return { status: 'skipped', error: outcome.reason }
    }

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
      return { status: 'skipped', error: delivery.reason }
    }
    delivered = true
    return { status: 'delivered', branch: delivery.branch, prUrl: delivery.prUrl }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('run failed', { repo, issue: issue.number, error: message })
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
  return 'committed'
}
