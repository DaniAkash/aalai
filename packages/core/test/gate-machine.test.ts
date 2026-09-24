import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor, setup, waitFor } from 'xstate'
import { openDb } from '@/modules/db/db'
import { answerGate, listGates, supersedeOpenGates } from '@/modules/gates'
import { writeArtifact } from '@/modules/work/artifacts'
import type { RunRef, Subject } from '@/modules/work/paths'
import { provideRunDeps, releaseRunDeps } from '@/run/machines/deps'
import { gateKeeper } from '@/run/machines/gateActor'

let dir: string
let handle: ReturnType<typeof openDb>

const SUBJECT: Subject = { repo: 'acme/widgets', kind: 'issue', number: 7 }
const RUN_ID = 'acme/widgets#7@1790000000000'
const RUN: RunRef = { subject: SUBJECT, runId: RUN_ID }

/** A machine shaped like the real one's gate branch and nothing else. */
const gating = setup({
  actors: { gateKeeper },
}).createMachine({
  id: 'gating',
  initial: 'waiting',
  context: { decision: '' },
  states: {
    waiting: {
      invoke: {
        src: 'gateKeeper',
        input: {
          runId: RUN_ID,
          repo: SUBJECT.repo,
          issue: SUBJECT.number,
          kind: 'plan',
          pollMs: 25,
        },
      },
      on: {
        GATE_ANSWERED: {
          target: 'settled',
          actions: ({ context, event }) => {
            context.decision = String(
              (event as { decision?: string }).decision ?? '',
            )
          },
        },
        GATE_SUPERSEDED: 'reasking',
      },
    },
    reasking: { type: 'final' },
    settled: { type: 'final' },
  },
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-gatem-'))
  process.env.AALAI_STATE_DIR = dir
  handle = openDb(join(dir, 'aalai.sqlite'))
  await writeArtifact(SUBJECT, 'plan', '# the plan\n')
  provideRunDeps(RUN_ID, {
    db: handle.sqlite,
    run: RUN,
    repo: SUBJECT.repo,
  } as never)
})

afterEach(() => {
  releaseRunDeps(RUN_ID)
  handle.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('parking', () => {
  test('entering the state opens a gate pinned to the current version', async () => {
    const actor = createActor(gating).start()
    await waitFor(actor, () => listGates(handle.sqlite).length > 0, {
      timeout: 2000,
    })

    const [gate] = listGates(handle.sqlite)
    expect(gate?.status).toBe('open')
    expect(gate?.kind).toBe('plan')
    // Pinned to bytes, which is what stops the approval transferring later.
    expect(gate?.artifactVersion).toBe('1')
    actor.stop()
  })

  test('an answer from another process wakes the run', async () => {
    const actor = createActor(gating).start()
    await waitFor(actor, () => listGates(handle.sqlite).length > 0, {
      timeout: 2000,
    })
    const [gate] = listGates(handle.sqlite)
    if (gate === undefined) throw new Error('no gate opened')

    // A genuinely separate process, because that is what `aalai approve` is.
    // Answering from this process would be delivered by the in-process bus and
    // would prove nothing about the mechanism the CLI actually depends on.
    const answering = Bun.spawn(
      [
        'bun',
        '-e',
        `import { Database } from 'bun:sqlite'
         const db = new Database(${JSON.stringify(join(dir, 'aalai.sqlite'))})
         db.query("UPDATE gates SET status='answered', decision='approved', answered_by='a terminal', answered_on='cli', answered_at=? WHERE id=?")
           .run(new Date().toISOString(), ${JSON.stringify(gate.id)})
         db.close()`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(await answering.exited).toBe(0)

    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 8000,
    })
    expect(settled.value).toBe('settled')
    expect(settled.context.decision).toBe('approved')
  })

  test('a gate answered while nothing was running settles immediately', async () => {
    // The cold restart: answered first, machine started afterwards.
    const primer = createActor(gating).start()
    await waitFor(primer, () => listGates(handle.sqlite).length > 0, {
      timeout: 2000,
    })
    primer.stop()
    const [gate] = listGates(handle.sqlite)
    if (gate === undefined) throw new Error('no gate opened')
    answerGate(handle.sqlite, {
      gateId: gate.id,
      decision: 'changes',
      reason: 'the criteria miss the error path',
      answeredBy: 'maintainer',
      answeredOn: 'cli',
    })

    const resumed = createActor(gating).start()
    const settled = await waitFor(resumed, (s) => s.status === 'done', {
      timeout: 4000,
    })

    expect(settled.value).toBe('settled')
    expect(settled.context.decision).toBe('changes')
    // Adopted rather than opened again: one question, asked once.
    expect(listGates(handle.sqlite)).toHaveLength(1)
  })

  test('a superseded gate sends the run back to ask again', async () => {
    const actor = createActor(gating).start()
    await waitFor(actor, () => listGates(handle.sqlite).length > 0, {
      timeout: 2000,
    })

    supersedeOpenGates(handle.sqlite, RUN_ID, 'plan')

    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 4000,
    })
    expect(settled.value).toBe('reasking')
  })
})
