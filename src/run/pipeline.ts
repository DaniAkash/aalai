import type { Config } from '@/config'
import type { GhIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import { buildTaskPrompt } from '@/prompts/implement-issue'
import { runAgentTurn } from '@/run/agent'
import { conventionsInstruction, detectConventions } from '@/run/conventions'
import { deliver, reportOutcomeOnIssue, type Delivery } from '@/run/deliver'
import { discardWorkspace, prepareWorkspace } from '@/run/workspace'

const log = logger('pipeline')

export interface PipelineResult {
  readonly status: 'delivered' | 'skipped' | 'failed'
  readonly branch?: string
  readonly prUrl?: string
  readonly error?: string
}

/**
 * Takes one issue from intake to a draft pull request.
 *
 * The stages are deliberately ordered so nothing reaches GitHub until the agent
 * has produced a verifiable diff: workspace, agent, verify, deliver. A failure
 * before the deliver stage leaves the repository untouched.
 */
export async function runIssue(
  repo: string,
  issue: GhIssue,
  config: Config,
): Promise<PipelineResult> {
  log.info('run starting', { repo, issue: issue.number, title: issue.title })
  const workspace = await prepareWorkspace(repo, issue.number, issue.title)

  try {
    const conventionFiles = await detectConventions(workspace.worktreePath)
    log.info('conventions detected', {
      files: conventionFiles.length === 0 ? 'none' : conventionFiles.join(','),
    })

    const turn = await runAgentTurn({
      worktree: workspace.worktreePath,
      task: buildTaskPrompt({
        repo,
        issue,
        conventionFiles,
        branch: workspace.branch,
        base: workspace.base,
      }),
      conventionsInstruction: conventionsInstruction(conventionFiles),
      config,
    })
    log.info('agent turn complete', {
      finish: turn.finishReason,
      tools: turn.toolCalls,
      tokens: turn.totalTokens,
    })

    const outcome: Delivery = await deliver({
      workspace,
      issue,
      report: turn.report,
      config,
    })
    await reportOutcomeOnIssue(repo, issue, outcome)

    if (!outcome.delivered) {
      if (!config.keepWorktreeOnFailure) {
        await discardWorkspace(workspace)
      }
      return { status: 'skipped', error: outcome.reason }
    }

    await discardWorkspace(workspace)
    return { status: 'delivered', branch: outcome.branch, prUrl: outcome.prUrl }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('run failed', { repo, issue: issue.number, error: message })
    if (!config.keepWorktreeOnFailure) {
      await discardWorkspace(workspace)
    }
    return { status: 'failed', error: message }
  }
}
