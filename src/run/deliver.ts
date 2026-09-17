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
  log.info('changes detected', { files: changed.length })

  await git.stageAll(workspace.worktreePath)
  const sha = await git.commit(
    workspace.worktreePath,
    buildCommitMessage(issue),
    config.commitEmail,
  )
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

export async function reportOutcomeOnIssue(
  repo: string,
  issue: GhIssue,
  outcome: Delivery,
): Promise<void> {
  const body = outcome.delivered
    ? `Opened a draft pull request for this issue: ${outcome.prUrl}\n\nIt is a draft. Review the diff and the verification output before marking it ready.`
    : `I picked this issue up but stopped without opening a pull request: ${outcome.reason}.\n\nNothing was pushed.`
  await commentOnIssue(repo, issue.number, body)
}
