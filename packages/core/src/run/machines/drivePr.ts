import { logger } from '@/lib/log'
import type { RunRef } from '@/modules/work/paths'
import type { RunDeps } from './deps'
import { provideRunDeps, releaseRunDeps } from './deps'
import { prLifecycle } from './prLifecycle'
import type { PrContext, PrOutcome } from './prTypes'
import { runMachine } from './snapshots'

const log = logger('pr')

/**
 * Keeps one pull request alive until it settles, persisting as it goes.
 *
 * The same shape as the other two drivers: dependencies registered before the
 * actor starts, snapshots written on every transition, and no timeout. A
 * timeout here would be worse than elsewhere, because waiting is most of what
 * this does: a pull request open for a week with nobody reviewing it is behaving
 * exactly as designed.
 */
export async function drivePullRequest(input: {
  runId: string
  repo: string
  prNumber: number
  issueNumber?: number
  run: RunRef
  deps: RunDeps
  snapshot?: unknown
  pollMs?: number
  windowMs?: number
  /**
   * Cancelled when this worker is no longer the one holding the claim.
   *
   * Losing a lease is not a warning. Another worker taking over means a second
   * machine is about to classify and push to the same branch, and two of those
   * on one branch is the thing the claim exists to prevent, so the one that lost
   * has to stop rather than finish what it was doing.
   */
  signal?: AbortSignal
}): Promise<{ outcome: PrOutcome; context: PrContext }> {
  provideRunDeps(input.runId, input.deps)
  try {
    const settled = await runMachine({
      db: input.deps.db,
      run: input.run,
      runId: input.runId,
      machine: 'prLifecycle',
      logic: prLifecycle,
      machineInput: {
        runId: input.runId,
        repo: input.repo,
        prNumber: input.prNumber,
        // Read from settings rather than assumed by the machine, so the two
        // allowances are the ones a person configured.
        maxCiFixes: input.deps.config.maxCiFixes,
        maxRevisions: input.deps.config.maxRevisions,
        ...(input.issueNumber === undefined
          ? {}
          : { issueNumber: input.issueNumber }),
        ...(input.pollMs === undefined ? {} : { pollMs: input.pollMs }),
        ...(input.windowMs === undefined ? {} : { windowMs: input.windowMs }),
      },
      ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const outcome = settled.context.outcome ?? {
      kind: 'failed' as const,
      error: 'the pull request run did not say how it ended',
    }
    log.info('pull request settled', {
      runId: input.runId,
      outcome: outcome.kind,
    })
    return { outcome, context: settled.context }
  } finally {
    releaseRunDeps(input.runId)
  }
}
