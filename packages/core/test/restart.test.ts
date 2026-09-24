import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor, fromPromise, setup, waitFor } from 'xstate'
import { openDb } from '@/modules/db/db'
import type { RunRef, Subject } from '@/modules/work/paths'
import { runAttempt } from '@/run/machines/runner'

let dir: string
let db: ReturnType<typeof openDb>

const SUBJECT: Subject = { repo: 'acme/widgets', kind: 'issue', number: 7 }
const RUN_ID = 'acme/widgets#7@1790000000000'
const RUN: RunRef = { subject: SUBJECT, runId: RUN_ID }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-restart-'))
  process.env.AALAI_STATE_DIR = dir
  db = openDb(join(dir, 'aalai.sqlite'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A run shaped like the real one: a long station as an invoked promise.
 *
 * The turns counter stands in for an agent turn, which is the thing a restart
 * must not buy twice.
 */
function buildMachine(turns: { count: number }, settleMs: number) {
  return setup({
    actors: {
      station: fromPromise(async () =>
        runAttempt({
          db: db.sqlite,
          run: RUN,
          runId: RUN_ID,
          station: 'implementer',
          revision: 0,
          execute: async () => {
            turns.count += 1
            await new Promise((resolve) => setTimeout(resolve, settleMs))
            return { sha: `commit-${turns.count}` }
          },
        }),
      ),
    },
  }).createMachine({
    id: 'run',
    initial: 'working',
    states: {
      working: { invoke: { src: 'station', onDone: 'done' } },
      done: { type: 'final' },
    },
  })
}

describe('restoring a machine', () => {
  test('xstate restarts the invocation, which is the hazard this guards', async () => {
    // Establishes the premise rather than trusting it: without the attempt
    // record, a restore runs the station a second time.
    let naive = 0
    const machine = setup({
      actors: {
        station: fromPromise(async () => {
          naive += 1
          await new Promise((resolve) => setTimeout(resolve, 50))
          return 'done'
        }),
      },
    }).createMachine({
      id: 'naive',
      initial: 'working',
      states: {
        working: { invoke: { src: 'station', onDone: 'done' } },
        done: { type: 'final' },
      },
    })

    const first = createActor(machine)
    first.start()
    const midFlight = first.getPersistedSnapshot()
    first.stop()

    const resumed = createActor(machine, { snapshot: midFlight })
    resumed.start()
    await waitFor(resumed, (s) => s.status === 'done')

    expect(naive).toBe(2)
  })

  test('with the attempt record, a resumed run does not buy a second turn', async () => {
    const turns = { count: 0 }

    const first = createActor(buildMachine(turns, 40))
    first.start()
    await waitFor(first, (s) => s.status === 'done')
    const snapshot = first.getPersistedSnapshot()
    first.stop()
    expect(turns.count).toBe(1)

    // The restart: same machine, restored snapshot, invocation runs again.
    const resumed = createActor(buildMachine(turns, 40), { snapshot })
    resumed.start()
    await waitFor(resumed, (s) => s.status === 'done')

    expect(turns.count).toBe(1)
  })

  test('the resumed run still reaches its end state', async () => {
    const turns = { count: 0 }
    const first = createActor(buildMachine(turns, 10))
    first.start()
    await waitFor(first, (s) => s.status === 'done')
    const snapshot = first.getPersistedSnapshot()
    first.stop()

    const resumed = createActor(buildMachine(turns, 10), { snapshot })
    resumed.start()
    const settled = await waitFor(resumed, (s) => s.status === 'done')

    expect(settled.status).toBe('done')
  })
})
