import type { Config } from '@/config'
import type { GhIssue } from '@/lib/gh'
import * as git from '@/lib/git'
import { logger } from '@/lib/log'
import { buildCommitMessage } from '@/prompts/implement-issue'
import { conventionsInstruction, detectConventions } from '@/run/conventions'
import { deliver, reportOutcomeOnIssue, type Delivery } from '@/run/deliver'
import { runAnalyst, runImplementer, runReviewer } from '@/run/stations'
import type { Analysis, Review } from '@/run/stations/schemas'
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

    const outcome = await implementAndReview({
      repo,
      issue,
      workspace,
      analysis,
      conventionFiles,
      config,
      onReviewWorktree: (path) => {
        reviewWorktree = path
      },
    })

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
    return { status: 'delivered', branch: delivery.branch, prUrl: delivery.prUrl }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('run failed', { repo, issue: issue.number, error: message })
    return { status: 'failed', error: message }
  } finally {
    if (reviewWorktree !== null) {
      await discardPath(workspace, reviewWorktree)
    }
    if (!config.keepWorktreeOnFailure) {
      await discardWorkspace(workspace)
    }
  }
}

type LoopOutcome =
  | { readonly kind: 'approved'; readonly review: Review; readonly implementerReport: string }
  | { readonly kind: 'stopped'; readonly reason: string }

/**
 * Implement, commit, review, and send back at most `maxRevisions` times.
 *
 * The commit happens before review on purpose. It is local and unpushed, and it
 * is what lets the reviewer read the change from its own checkout rather than
 * from the working directory the implementer just left behind.
 */
async function implementAndReview(input: {
  repo: string
  issue: GhIssue
  workspace: Workspace
  analysis: Analysis
  conventionFiles: readonly string[]
  config: Config
  onReviewWorktree: (path: string) => void
}): Promise<LoopOutcome> {
  const { repo, issue, workspace, analysis, conventionFiles, config } = input
  let revision: { review: Review; attempt: number } | undefined
  let implementerReport = ''

  for (let attempt = 0; attempt <= config.maxRevisions; attempt += 1) {
    const turn = await runImplementer({
      repo,
      issue,
      worktree: workspace.worktreePath,
      analysis,
      conventionFiles,
      revision,
      config,
    })
    implementerReport = turn.text

    const changed = await git.changedFiles(workspace.worktreePath)
    const { deliverable, generated } = git.partitionStagePaths(changed)
    if (generated.length > 0) {
      log.warn('ignoring generated output the agent produced', { count: generated.length })
    }
    if (deliverable.length === 0) {
      return { kind: 'stopped', reason: 'the agent made no file changes' }
    }

    await git.stageAll(workspace.worktreePath)
    if (!(await git.hasStagedChanges(workspace.worktreePath))) {
      return { kind: 'stopped', reason: 'the agent changed only build or dependency output' }
    }
    const sha = await git.commit(
      workspace.worktreePath,
      attempt === 0
        ? buildCommitMessage(issue)
        : `${buildCommitMessage(issue).split('\n')[0] ?? issue.title} (review pass ${attempt})`,
      { name: config.commitName, email: config.commitEmail },
    )
    log.info('committed locally', { sha: sha.slice(0, 8), attempt })

    const reviewPath = await prepareReviewWorkspace(workspace)
    input.onReviewWorktree(reviewPath)

    const { review } = await runReviewer({
      repo,
      issue,
      worktree: reviewPath,
      analysis,
      base: workspace.base,
      branch: workspace.branch,
      config,
    })
    const passed = review.criteria_results.filter((r) => r.pass).length
    log.info('verdict', {
      verdict: review.verdict,
      criteria: `${passed}/${review.criteria_results.length}`,
      blocking: review.blocking_findings.length,
    })

    if (review.verdict === 'approve') {
      return { kind: 'approved', review, implementerReport }
    }
    if (review.verdict === 'reject') {
      return {
        kind: 'stopped',
        reason: `the reviewer rejected the approach: ${review.summary}`,
      }
    }
    revision = { review, attempt: attempt + 1 }
    log.warn('changes requested, sending back', { attempt: attempt + 1 })
  }

  return {
    kind: 'stopped',
    reason: `the reviewer still requested changes after ${config.maxRevisions} revisions`,
  }
}
