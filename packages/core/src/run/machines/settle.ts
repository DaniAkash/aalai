import type { AnyStateMachine, InputFrom } from 'xstate'
import { logger } from '@/lib/log'
import type { RunRef } from '@/modules/work/paths'
import type { RunDeps } from './deps'
import { provideRunDeps, releaseRunDeps } from './deps'
import { runMachine } from './snapshots'

const log = logger('run')

/**
 * Runs one machine to a final state and hands back what it decided.
 *
 * Every driver did the same four things around the same call: register the
 * dependencies, run the machine, release them whatever happened, and fall back
 * to a failure when the machine settled without recording an outcome. Four
 * copies of that is four places for the release to be forgotten.
 *
 * No timeout, deliberately, and for a different reason in each machine that uses
 * it: a triage can wait a fortnight on a reporter, a pull request watch can be
 * open for weeks, and a review can sit on a trust gate for as long as it takes
 * somebody to decide whether to run a stranger's code.
 */
export async function settleMachine<
  TLogic extends AnyStateMachine,
  TOutcome,
  TContext,
>(input: {
  runId: string
  run: RunRef
  deps: RunDeps
  machine: string
  logic: TLogic
  machineInput: InputFrom<TLogic>
  snapshot?: unknown
  signal?: AbortSignal
  /** What to call it when the machine ended without saying how. */
  missing: TOutcome
}): Promise<{ outcome: TOutcome; context: TContext }> {
  provideRunDeps(input.runId, input.deps)
  try {
    const settled = await runMachine({
      db: input.deps.db,
      run: input.run,
      runId: input.runId,
      machine: input.machine,
      logic: input.logic,
      machineInput: input.machineInput,
      ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    // The one place a snapshot's context is read without the machine's own
    // types in scope. Each caller names the context it expects, which is the
    // same type its machine declares, so the narrowing is checked at every call
    // site rather than trusted here.
    const context = (settled as { context: TContext }).context
    const outcome = (context as { outcome?: TOutcome }).outcome ?? input.missing
    log.info(`${input.machine} settled`, {
      runId: input.runId,
      outcome: (outcome as { kind?: string }).kind ?? 'unknown',
    })
    return { outcome, context }
  } finally {
    releaseRunDeps(input.runId)
  }
}
