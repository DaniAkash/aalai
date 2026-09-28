import type { Database } from 'bun:sqlite'
import { createActor, fromPromise, setup, waitFor } from 'xstate'
import { listGates } from '@/modules/gates'
import type { Subject } from '@/modules/work/paths'
import { provideRunDeps, releaseRunDeps } from '@/run/machines/deps'
import { gateKeeper } from '@/run/machines/gateActor'

/**
 * A run parked on a plan gate, with the reply turn stubbed.
 *
 * The gate branch of the real machine and nothing else, so an end to end script
 * can exercise a reply reaching a real keeper without waiting on an agent. Built
 * once here because two scripts had grown their own copies and a change to the
 * gate's shape would have had to be made in both, or worse, in one.
 */
export interface ParkedMachine {
  /** Every question a turn was started for, in order. */
  readonly asked: string[]
  /** Resolves when the gate is answered and the run moves on. */
  settled: () => Promise<unknown>
  stop: () => void
}

export async function parkOnGate(input: {
  db: Database
  subject: Subject
  runId: string
  issue: number
  /** What the stubbed turn does before returning. */
  onAnswer?: (question: string) => Promise<void>
}): Promise<ParkedMachine> {
  const asked: string[] = []

  const machine = setup({
    actors: {
      gateKeeper,
      replier: fromPromise(
        async ({ input: turn }: { input: { question: string } }) => {
          asked.push(turn.question)
          await input.onAnswer?.(turn.question)
          return {}
        },
      ),
    },
  }).createMachine({
    id: 'parked',
    initial: 'gatingPlan',
    states: {
      gatingPlan: {
        initial: 'waiting',
        invoke: {
          src: 'gateKeeper',
          input: {
            runId: input.runId,
            repo: input.subject.repo,
            issue: input.issue,
            kind: 'plan',
            pollMs: 50,
          },
        },
        states: {
          waiting: { on: { REPLY_RECEIVED: 'answering' } },
          answering: {
            invoke: {
              src: 'replier',
              input: ({ event }) => ({
                question: String(
                  (event as { question?: string }).question ?? '',
                ),
              }),
              onDone: 'waiting',
              onError: 'waiting',
            },
          },
        },
        on: { GATE_ANSWERED: 'settled', GATE_SUPERSEDED: 'settled' },
      },
      settled: { type: 'final' },
    },
  })

  provideRunDeps(input.runId, {
    db: input.db,
    run: { subject: input.subject, runId: input.runId },
    repo: input.subject.repo,
  } as never)

  const actor = createActor(machine).start()
  await waitFor(
    actor,
    () =>
      listGates(input.db, { runId: input.runId, status: 'open' }).length > 0,
    { timeout: 5000 },
  )

  return {
    asked,
    settled: () =>
      waitFor(actor, (state) => state.status === 'done', { timeout: 8000 }),
    stop: () => {
      actor.stop()
      releaseRunDeps(input.runId)
    },
  }
}
