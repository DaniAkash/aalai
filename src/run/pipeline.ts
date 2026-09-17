import type { Config } from '@/config'
import type { GhIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import { buildTaskPrompt, buildAgentRules } from '@/prompts/implement-issue'
import { runAgentTurn } from '@/run/agent'
import { conventionsInstruction, detectConventions } from '@/run/conventions'
import { deliver, reportOutcomeOnIssue, type Delivery } from '@/run/deliver'
import { discardWorkspace, prepareWorkspace, type Workspace } from '@/run/workspace'

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
 * Stages are ordered so nothing reaches GitHub until the agent has produced a
 * verifiable diff: workspace, agent, verify, deliver. Every stage, workspace
 * setup included, resolves to a `PipelineResult` rather than throwing, because
 * the caller finalises the run's claim from that result: a rejection here would
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
      systemRules: `${buildAgentRules()}\n\n${conventionsInstruction(conventionFiles)}`,
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
