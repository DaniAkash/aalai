import type { Config } from '@/config'
import { commentOnIssue, createDraftPullRequest, type GhIssue } from '@/lib/gh'
import * as git from '@/lib/git'
import { logger } from '@/lib/log'
import { buildCommitMessage, buildPullRequestBody } from '@/prompts/implement-issue'
import { redactDeep, redactLocalPaths } from '@/lib/redact'
import type { Analysis, Review } from '@/run/stations/schemas'
import type { Workspace } from '@/run/workspace'

const log = logger('deliver')

export interface DeliveryInput {
  readonly workspace: Workspace
  readonly issue: GhIssue
  readonly analysis: Analysis
  readonly review: Review
  readonly report: string
  readonly config: Config
}

export type Delivery =
  | { readonly delivered: true; readonly prUrl: string; readonly branch: string }
  | { readonly delivered: false; readonly reason: string }

/**
 * Commits, pushes, and opens a draft pull request.
 *
 * Every credential-bearing operation lives here rather than in the agent turn.
 * The agent produced a diff; aalai is what turns a diff into a pull request, and
 * the draft flag is not configurable because it is the human gate.
 */
export async function deliver(input: DeliveryInput): Promise<Delivery> {
  const { workspace, issue, analysis, review, report, config } = input

  // The implementer's work is already committed locally; the loop did that so
  // the reviewer could read it from its own checkout. Delivery is the first
  // point at which anything leaves this machine.
  const changed = await git.diffNames(workspace.worktreePath, workspace.base)
  if (changed.length === 0) {
    log.warn('nothing to deliver', { issue: issue.number })
    return { delivered: false, reason: 'the run produced no committed changes' }
  }

  await git.pushBranch(workspace.worktreePath, workspace.branch)
  log.info('pushed', { branch: workspace.branch })

  const diffStat = await git.diffStat(workspace.worktreePath, workspace.base)
  const prUrl = await createDraftPullRequest({
    repo: workspace.repo,
    head: workspace.branch,
    base: workspace.base,
    title: `${buildCommitMessage(issue).split('\n')[0] ?? issue.title}`,
    // Every station ran inside a worktree and can cite absolute paths: the
    // analyst in its problem statement, the reviewer in its evidence fields,
    // the implementer in its report. All of it is published, so all of it is
    // redacted, not just the report that happened to leak first.
    body: buildPullRequestBody({
      issue,
      analysis: redactDeep(analysis, workspace.worktreePath),
      review: redactDeep(review, workspace.worktreePath),
      report: redactLocalPaths(report, workspace.worktreePath),
      diffStat,
      changedFiles: changed,
    }),
  })
  log.info('draft pull request opened', { url: prUrl })

  return { delivered: true, prUrl, branch: workspace.branch }
}

export async function reportOutcomeOnIssue(
  repo: string,
  issue: GhIssue,
  outcome: Delivery,
): Promise<void> {
  const body = outcome.delivered
    ? `Opened a draft pull request for this issue: ${outcome.prUrl}\n\nIt is a draft. Review the diff and the per-criterion verdict before marking it ready.`
    : `I picked this issue up but stopped without opening a pull request: ${outcome.reason}.\n\nNothing was pushed.`
  try {
    await commentOnIssue(repo, issue.number, body)
  } catch (error) {
    log.warn('could not comment on the issue', {
      repo,
      issue: issue.number,
      error: error instanceof Error ? error.message : error,
    })
  }
}
