import type { Config } from '@/config'
import { emit, registerRunRoot } from '@/events/bus'
import type { GhIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import { getDb } from '@/modules/db/db'
import type { RunRef, Subject } from '@/modules/work/paths'
import { recordBestEffort, recordRun, snapshotOf } from '@/run/artifacts'
import { detectConventions } from '@/run/conventions'
import { type Delivery, deliver, reportOutcomeOnIssue } from '@/run/deliver'
import { driveIssueWork } from '@/run/machines/drive'
import type { IssueWorkContext } from '@/run/machines/issueWork'
import {
  adoptWorkspace,
  discardPath,
  discardWorkspace,
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
export interface ResumeFrom {
  readonly runId: string
  readonly snapshot: unknown
}

/**
 * Picks a run back up where a previous process left it.
 *
 * The same path as a fresh run with two differences: the worktree is adopted
 * rather than rebuilt, because rebuilding it would throw away the commits this
 * run is being resumed to keep, and the machine starts from its snapshot.
 */
export async function resumeIssue(
  repo: string,
  issue: GhIssue,
  config: Config,
  from: ResumeFrom,
): Promise<PipelineResult> {
  return await work(repo, issue, config, from)
}

export async function runIssue(
  repo: string,
  issue: GhIssue,
  config: Config,
): Promise<PipelineResult> {
  return await work(repo, issue, config, undefined)
}

async function work(
  repo: string,
  issue: GhIssue,
  config: Config,
  from: ResumeFrom | undefined,
): Promise<PipelineResult> {
  const runId = from?.runId ?? `${repo}#${issue.number}@${Date.now()}`
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
    workspace = await openWorkspace(repo, issue, from !== undefined)
  } catch (error) {
    return await reportWorkspaceFailure(runId, repo, issue, run, error)
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
    const settled = await driveIssueWork({
      runId,
      repo,
      issueNumber: issue.number,
      run,
      ...(from === undefined ? {} : { snapshot: from.snapshot }),
      deps: {
        db: getDb().sqlite,
        config,
        issue,
        repo,
        workspace,
        run,
        conventionFiles,
      },
    })
    reviewWorktree = settled.context.reviewWorktree ?? null

    const { analysis, review } = settled.context
    if (
      settled.state !== 'approved' ||
      analysis === undefined ||
      review === undefined
    ) {
      result = await reportUnapproved(runId, repo, issue, settled.context)
      return result
    }

    emit({ type: 'stage.entered', runId, stage: 'deliver', at: Date.now() })

    const delivery: Delivery = await deliver({
      workspace,
      issue,
      analysis,
      review,
      report: settled.context.implementerReport,
      config,
    })
    await reportOutcomeOnIssue(repo, issue, delivery)
    result = announceDelivery(runId, delivery)
    delivered = result.status === 'delivered'
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('run failed', { repo, issue: issue.number, error: message })
    emit({ type: 'run.failed', runId, error: message, at: Date.now() })
    result = { status: 'failed', error: message }
    return result
  } finally {
    await recordBestEffort('run', () =>
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

/** Turns what delivery did into the run's result, and says so on the bus. */
function announceDelivery(runId: string, delivery: Delivery): PipelineResult {
  if (!delivery.delivered) {
    emit({
      type: 'run.stopped',
      runId,
      reason: delivery.reason,
      at: Date.now(),
    })
    return { status: 'skipped', error: delivery.reason }
  }
  emit({
    type: 'run.delivered',
    runId,
    prUrl: delivery.prUrl,
    branch: delivery.branch,
    at: Date.now(),
  })
  return {
    status: 'delivered',
    branch: delivery.branch,
    prUrl: delivery.prUrl,
  }
}

/**
 * A run that never got a worktree.
 *
 * This path returns before the try whose finally records the run, so the
 * snapshot is written here instead: a run that failed this early is still a
 * run, and its outcome is the only thing left of it.
 */
async function reportWorkspaceFailure(
  runId: string,
  repo: string,
  issue: GhIssue,
  run: RunRef,
  error: unknown,
): Promise<PipelineResult> {
  const message = error instanceof Error ? error.message : String(error)
  log.error('workspace setup failed', {
    repo,
    issue: issue.number,
    error: message,
  })
  const failed: PipelineResult = {
    status: 'failed',
    error: `workspace setup failed: ${message}`,
  }
  emit({ type: 'run.failed', runId, error: failed.error ?? '', at: Date.now() })
  await recordBestEffort('run', () =>
    recordRun(run, snapshotOf(runId, repo, issue.number, failed)),
  )
  return failed
}

/**
 * The worktree a run works in.
 *
 * Adopted when resuming and built fresh otherwise. A rebuilt worktree is a
 * clean one, which is the whole point for a new run and the exact opposite of
 * what a resumed one needs: it would throw away the commits the run is being
 * resumed to keep. Adoption returning nothing means there is nothing to keep,
 * so the run starts over rather than refusing to run.
 */
async function openWorkspace(
  repo: string,
  issue: GhIssue,
  resuming: boolean,
): Promise<Workspace> {
  const adopted = resuming
    ? await adoptWorkspace(repo, issue.number, issue.title)
    : undefined
  return adopted ?? (await prepareWorkspace(repo, issue.number, issue.title))
}

/**
 * A run the machine did not carry to an approved verdict.
 *
 * A failure is the factory's own problem and is not reported on the issue; a
 * stop is a decision somebody asked for, and is.
 */
async function reportUnapproved(
  runId: string,
  repo: string,
  issue: GhIssue,
  context: IssueWorkContext,
): Promise<PipelineResult> {
  const stopped = context.outcome ?? {
    kind: 'stopped' as const,
    reason: 'the run ended without an outcome',
  }
  if (stopped.kind === 'failed') {
    emit({ type: 'run.failed', runId, error: stopped.error, at: Date.now() })
    return { status: 'failed', error: stopped.error }
  }
  emit({ type: 'run.stopped', runId, reason: stopped.reason, at: Date.now() })
  await reportOutcomeOnIssue(repo, issue, {
    delivered: false,
    reason: stopped.reason,
  })
  return { status: 'skipped', error: stopped.reason }
}
