import { logger } from '@/lib/log'
import type { RunRef } from '@/modules/work/paths'
import type { RunDeps } from './deps'
import { provideRunDeps } from './deps'
import { runMachine } from './snapshots'
import { triageMachine } from './triage'
import type { TriageContext, TriageOutcome } from './triageTypes'

const log = logger('triage')

/**
 * Runs one issue's triage to a final state, persisting as it goes.
 *
 * The same shape as `driveIssueWork`, and deliberately so: dependencies
 * registered before the actor starts and released after it settles, snapshots
 * written on every transition, and no timeout. A run parked on a reporter can
 * legitimately sit for a fortnight, so a clock here would be a clock that
 * eventually kills a run for the crime of waiting exactly as designed.
 */
export async function driveTriage(input: {
  runId: string
  repo: string
  issueNumber: number
  run: RunRef
  deps: RunDeps
  snapshot?: unknown
  gatePollMs?: number
}): Promise<{ outcome: TriageOutcome; context: TriageContext }> {
  provideRunDeps(input.runId, input.deps)
  const settled = await runMachine({
    db: input.deps.db,
    run: input.run,
    runId: input.runId,
    machine: 'triage',
    logic: triageMachine,
    machineInput: {
      runId: input.runId,
      repo: input.repo,
      issueNumber: input.issueNumber,
      ...(input.gatePollMs === undefined
        ? {}
        : { gatePollMs: input.gatePollMs }),
    },
    ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
  })
  const outcome = settled.context.outcome ?? {
    kind: 'failed' as const,
    error: 'triage did not say how it ended',
  }
  log.info('triage settled', { runId: input.runId, outcome: outcome.kind })
  return { outcome, context: settled.context }
}
