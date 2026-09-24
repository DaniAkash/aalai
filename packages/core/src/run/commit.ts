import type { Config } from '@/config'
import { emit } from '@/events/bus'
import type { GhIssue } from '@/lib/gh'
import * as git from '@/lib/git'
import { logger } from '@/lib/log'
import { buildCommitMessage } from '@/prompts/implement-issue'
import type { Workspace } from '@/run/workspace'

/** What committing the implementer's work produced. */
export type CommitOutcome = 'committed' | 'no-changes' | 'generated-only'

const log = logger('pipeline')

/** Stages the implementer's work and commits it locally, unpushed. */
export async function commitImplementerWork(
  runId: string,
  workspace: Workspace,
  issue: GhIssue,
  attempt: number,
  config: Config,
): Promise<CommitOutcome> {
  const changed = await git.changedFiles(workspace.worktreePath)
  const { deliverable, generated } = git.partitionStagePaths(changed)
  if (generated.length > 0) {
    log.warn('ignoring generated output the agent produced', {
      count: generated.length,
    })
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
    attempt === 0
      ? buildCommitMessage(issue)
      : `${subject} (review pass ${attempt})`,
    { name: config.commitName, email: config.commitEmail },
  )
  log.info('committed locally', { sha: sha.slice(0, 8), attempt })
  emit({ type: 'commit.made', runId, sha, attempt, at: Date.now() })
  return 'committed'
}
