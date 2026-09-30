import type { RunRef } from '@/modules/work/paths'
import type { RunDeps } from './deps'
import { prReview } from './prReview'
import type { ReviewContext, ReviewOutcome } from './reviewTypes'
import { settleMachine } from './settle'

/**
 * Reviews one pull request the factory did not write, to a final state.
 *
 * The same shape as the other three drivers. No timeout, for the same reason as
 * the others and one of its own: this can sit on a trust gate for as long as it
 * takes somebody to decide whether to run a stranger's code, and that is a
 * decision nobody should be hurried into by a clock.
 */
export async function driveReview(input: {
  runId: string
  repo: string
  prNumber: number
  title: string
  run: RunRef
  deps: RunDeps
  snapshot?: unknown
  gatePollMs?: number
  signal?: AbortSignal
}): Promise<{ outcome: ReviewOutcome; context: ReviewContext }> {
  return settleMachine<typeof prReview, ReviewOutcome, ReviewContext>({
    runId: input.runId,
    run: input.run,
    deps: input.deps,
    machine: 'prReview',
    logic: prReview,
    machineInput: {
      runId: input.runId,
      repo: input.repo,
      prNumber: input.prNumber,
      title: input.title,
      ...(input.gatePollMs === undefined
        ? {}
        : { gatePollMs: input.gatePollMs }),
    },
    ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    missing: {
      kind: 'failed' as const,
      error: 'the review did not say how it ended',
    },
  })
}
