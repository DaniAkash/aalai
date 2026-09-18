import type { Config } from '@/config'
import { commentOnIssue, createDraftPullRequest, type GhIssue } from '@/lib/gh'
import * as git from '@/lib/git'
import { logger } from '@/lib/log'
import { buildCommitMessage, buildPullRequestBody } from '@/prompts/implement-issue'
import type { Workspace } from '@/run/workspace'

const log = logger('deliver')

export interface DeliveryInput {
  readonly workspace: Workspace
  readonly issue: GhIssue
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
  const { workspace, issue, report, config } = input

  const changed = await git.changedFiles(workspace.worktreePath)
  if (changed.length === 0) {
    log.warn('agent produced no changes', { issue: issue.number })
    return { delivered: false, reason: 'the agent made no file changes' }
  }
  const { deliverable, generated } = git.partitionStagePaths(changed)
  if (generated.length > 0) {
    log.warn('excluding build or dependency output the agent generated', {
      count: generated.length,
      sample: generated.slice(0, 3).join(', '),
    })
  }
  if (deliverable.length === 0) {
    log.warn('only generated output changed', { issue: issue.number })
    return { delivered: false, reason: 'the agent changed only build or dependency output' }
  }
  log.info('changes detected', { files: deliverable.length })

  const unstaged = await git.stageAll(workspace.worktreePath)
  if (unstaged.length > 0) {
    log.warn('removed generated output the agent had staged itself', {
      count: unstaged.length,
      sample: unstaged.slice(0, 3).join(', '),
    })
  }
  const sha = await git.commit(workspace.worktreePath, buildCommitMessage(issue), {
    name: config.commitName,
    email: config.commitEmail,
  })
  log.info('committed', { sha: sha.slice(0, 8) })

  await git.pushBranch(workspace.worktreePath, workspace.branch)
  log.info('pushed', { branch: workspace.branch })

  const diffStat = await git.diffStat(workspace.worktreePath, workspace.base)
  const prUrl = await createDraftPullRequest({
    repo: workspace.repo,
    head: workspace.branch,
    base: workspace.base,
    title: `${buildCommitMessage(issue).split('\n')[0] ?? issue.title}`,
    body: buildPullRequestBody({ issue, report, diffStat, changedFiles: changed }),
  })
  log.info('draft pull request opened', { url: prUrl })

  return { delivered: true, prUrl, branch: workspace.branch }
}

/**
 * Comments the outcome on the originating issue.
 *
 * Best effort on purpose. By the time this runs the pull request already exists,
 * so letting a failed comment fail the run would discard a real delivery and
 * mark the issue permanently unretryable. A missing comment is cosmetic; a lost
 * pull request URL is not.
 */
export async function reportOutcomeOnIssue(
  repo: string,
  issue: GhIssue,
  outcome: Delivery,
): Promise<void> {
  const body = outcome.delivered
    ? `Opened a draft pull request for this issue: ${outcome.prUrl}\n\nIt is a draft. Review the diff and the verification output before marking it ready.`
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
