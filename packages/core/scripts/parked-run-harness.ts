/**
 * A run parked at the seeded gate, with a stubbed analyst turn.
 *
 * Lets the interface be driven against a real machine: a reply typed in a
 * browser wakes a real gate keeper, moves a real state machine into `answering`,
 * and the answer appears in the thread the same way an agent's would. The only
 * thing faked is the agent turn itself, because a real one is minutes of waiting
 * to observe a mechanism that has nothing to do with the model.
 *
 * Run from `packages/core` with `AALAI_STATE_DIR=<dir> bun run scripts/parked-run-harness.ts`.
 */
import { createActor, fromPromise, setup, waitFor } from 'xstate'
import { openDb } from '@/modules/db/db'
import { listGates } from '@/modules/gates'
import { appendEntry } from '@/modules/work/conversation'
import { provideRunDeps } from '@/run/machines/deps'
import { gateKeeper } from '@/run/machines/gateActor'
import { persistSnapshot } from '@/run/machines/snapshots'
import { workState } from '@/run/machines/types'

const repo = process.env.SEED_REPO ?? 'DaniAkash/aalai-demo'
const issue = Number(process.env.SEED_ISSUE ?? '412')
const subject = { repo, kind: 'issue' as const, number: issue }
const runId = `${repo}#${issue}@1790000000412`

const { sqlite } = openDb()
provideRunDeps(runId, {
  db: sqlite,
  run: { subject, runId },
  repo,
} as never)

const machine = setup({
  actors: {
    gateKeeper,
    replier: fromPromise(async ({ input }: { input: { question: string } }) => {
      process.stdout.write(`answering: ${input.question}\n`)
      // Long enough that a browser can observe the answering state, and
      // lengthened by SEED_TURN_MS when a screenshot needs a wider window than
      // the interface's own poll interval.
      await new Promise((resolve) =>
        setTimeout(resolve, Number(process.env.SEED_TURN_MS ?? '4000')),
      )
      await appendEntry(subject, {
        author: 'analyst',
        role: 'station',
        body: `Because a 2GB dump does not fit in memory. Buffering would need the whole file resident, which breaks acceptance criterion 3.`,
      })
      return {}
    }),
  },
}).createMachine({
  id: 'parked',
  // Parallel with a `work` region, like the real machine, so the value this
  // persists has the shape `workState` and `gateActivity` actually read.
  type: 'parallel',
  states: {
    work: {
      initial: 'gatingPlan',
      states: {
        gatingPlan: {
          initial: 'waiting',
          invoke: {
            src: 'gateKeeper',
            input: { runId, repo, issue, kind: 'plan', pollMs: 500 },
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
    },
  },
})

const actor = createActor(machine).start()

// Same as the real driver: every transition writes the compact value and the
// whole snapshot, which is what lets the thread endpoint report `answering`.
let writes: Promise<void> = Promise.resolve()
actor.subscribe((snapshot) => {
  const value = workState(snapshot.value)
  const persisted = actor.getPersistedSnapshot()
  writes = writes.then(() =>
    persistSnapshot({
      db: sqlite,
      run: { subject, runId },
      runId,
      machine: 'issueWork',
      value,
      snapshot: persisted,
    }),
  )
})

await waitFor(
  actor,
  () => listGates(sqlite, { runId, status: 'open' }).length > 0,
  { timeout: 10_000 },
)
process.stdout.write('parked and listening\n')
await waitFor(actor, (state) => state.status === 'done', { timeout: 3_600_000 })
process.stdout.write('the gate was answered, stopping\n')
actor.stop()
sqlite.close()
