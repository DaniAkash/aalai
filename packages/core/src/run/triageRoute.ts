import type { Config } from '@/config'
import { emit } from '@/events/bus'
import type { GhIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import { getDb } from '@/modules/db/db'
import type { RunRef } from '@/modules/work/paths'
import { driveTriage } from '@/run/machines/driveTriage'
import type { TriageOutcome } from '@/run/machines/triageTypes'
import type { PipelineResult } from '@/run/pipeline'
import { policyForRepo, triageFirst } from '@/run/policy'
import type { Workspace } from '@/run/workspace'

const log = logger('triage')

/**
 * Classifies first when the repository asks for it, and says so if that settled
 * the issue.
 *
 * Returns nothing when the work should carry on, which is the only case that
 * reaches a station that writes code.
 */
export async function triageIfAsked(input: {
  runId: string
  repo: string
  issue: GhIssue
  run: RunRef
  config: Config
  workspace: Workspace
  conventionFiles: readonly string[]
}): Promise<PipelineResult | undefined> {
  if (!triageFirst(policyForRepo(input.config, input.repo))) {
    return undefined
  }
  const triaged = await driveTriage({
    runId: input.runId,
    repo: input.repo,
    issueNumber: input.issue.number,
    run: input.run,
    deps: {
      db: getDb().sqlite,
      config: input.config,
      issue: input.issue,
      repo: input.repo,
      workspace: input.workspace,
      run: input.run,
      conventionFiles: input.conventionFiles,
    },
  })
  if (triaged.outcome.kind === 'handOff') {
    log.info('triage handed off to be worked on', {
      runId: input.runId,
      classification: triaged.outcome.triage.classification,
    })
    return undefined
  }
  return reportTriaged(input.runId, triaged.outcome)
}

function reasonFor(outcome: TriageOutcome): string {
  switch (outcome.kind) {
    case 'escalated':
      return 'a security report, escalated privately and not answered in public'
    case 'stale':
      return 'closed after the reporter never came back'
    case 'answered':
      return `triaged and answered (${outcome.decision})`
    default:
      return 'triaged'
  }
}

function reportTriaged(runId: string, outcome: TriageOutcome): PipelineResult {
  if (outcome.kind === 'failed') {
    emit({ type: 'run.failed', runId, error: outcome.error, at: Date.now() })
    return { status: 'failed', error: outcome.error }
  }
  const reason = reasonFor(outcome)
  emit({ type: 'run.stopped', runId, reason, at: Date.now() })
  return { status: 'skipped' }
}
