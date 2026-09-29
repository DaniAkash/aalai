import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor, setup, waitFor } from 'xstate'
import { openDb } from '@/modules/db/db'
import { answerGate, openGate } from '@/modules/gates'
import type { RunRef, Subject } from '@/modules/work/paths'
import { readQueued } from '@/modules/work/store'
import { provideRunDeps, releaseRunDeps } from '@/run/machines/deps'
import { reporterWatch } from '@/run/machines/reporterActor'

/**
 * The wait on somebody who does not work for you.
 *
 * Measured in weeks in production and in milliseconds here, which is the point
 * of the thresholds being inputs: a test that waits a fortnight is a test
 * nobody runs.
 */

let dir: string
let handle: ReturnType<typeof openDb>

const SUBJECT: Subject = { repo: 'acme/waiting', kind: 'issue', number: 61 }
const RUN_ID = 'acme/waiting#61@1790000000061'
const RUN: RunRef = { subject: SUBJECT, runId: RUN_ID }
const REPORTER = 'a-stranger'

let comments: {
  id: number
  html_url: string
  body: string
  author: string
  created_at: string
}[] = []

mock.module('@/lib/gh', () => ({
  listIssueCommentBodies: async () => comments,
}))

/** A machine that does nothing but hold the wait, so its events are observable. */
function machine(asked: string, thresholds: Record<string, number>) {
  return setup({
    actors: { reporterWatch },
  }).createMachine({
    id: 'waiting',
    initial: 'awaiting',
    context: { last: '' },
    states: {
      awaiting: {
        invoke: {
          src: 'reporterWatch',
          input: {
            runId: RUN_ID,
            repo: SUBJECT.repo,
            issue: SUBJECT.number,
            askedAt: asked,
            pollMs: 20,
            nudgeAfterMs: thresholds.nudge ?? 60_000,
            staleAfterMs: thresholds.stale ?? 120_000,
          },
        },
        on: {
          REPORTER_REPLIED: {
            target: 'woke',
            actions: ({ context }) => {
              context.last = 'replied'
            },
          },
          REPORTER_NUDGED: {
            target: 'nudged',
            actions: ({ context }) => {
              context.last = 'nudged'
            },
          },
          REPORTER_SILENT: {
            target: 'gaveUp',
            actions: ({ context }) => {
              context.last = 'silent'
            },
          },
        },
      },
      woke: { type: 'final' },
      nudged: { type: 'final' },
      gaveUp: { type: 'final' },
    },
  })
}

let actors: { stop: () => void }[] = []

function watch(asked: string, thresholds: Record<string, number> = {}) {
  const actor = createActor(machine(asked, thresholds)).start()
  actors.push(actor)
  return actor
}

beforeEach(() => {
  actors = []
  comments = []
  dir = mkdtempSync(join(tmpdir(), 'aalai-waiting-'))
  process.env.AALAI_STATE_DIR = dir
  handle = openDb(join(dir, 'aalai.sqlite'))
  provideRunDeps(RUN_ID, {
    db: handle.sqlite,
    run: RUN,
    repo: SUBJECT.repo,
    issue: { number: SUBJECT.number, user: { login: REPORTER } },
  } as never)
})

afterEach(() => {
  for (const actor of actors) {
    actor.stop()
  }
  releaseRunDeps(RUN_ID)
  handle.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

describe('waking on an answer', () => {
  test('the reporter answering wakes it', async () => {
    const asked = ago(1000)
    comments = [
      {
        id: 1,
        html_url: 'u',
        body: 'it is version 2.1',
        author: REPORTER,
        created_at: new Date().toISOString(),
      },
    ]
    const actor = watch(asked)
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.value).toBe('woke')
  })

  test('somebody else answering is not an answer', async () => {
    // They were not asked, and a passer-by saying "same here" is not the
    // detail the question was about.
    const asked = ago(1000)
    comments = [
      {
        id: 1,
        html_url: 'u',
        body: 'same here',
        author: 'somebody-else',
        created_at: new Date().toISOString(),
      },
    ]
    const actor = watch(asked, { nudge: 60_000, stale: 120_000 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(actor.getSnapshot().status).toBe('active')
  })

  test('something the reporter said before being asked is not an answer', async () => {
    // Their original report is a comment by them, and it is not a reply to a
    // question that had not been asked yet.
    comments = [
      {
        id: 1,
        html_url: 'u',
        body: 'the original report',
        author: REPORTER,
        created_at: ago(10_000),
      },
    ]
    const actor = watch(ago(1000), { nudge: 60_000, stale: 120_000 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(actor.getSnapshot().status).toBe('active')
  })
})

describe('giving up, eventually and politely', () => {
  test('silence past the threshold asks once more', async () => {
    const actor = watch(ago(5000), { nudge: 1000, stale: 120_000 })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.value).toBe('nudged')
  })

  test('the nudge is queued rather than posted', async () => {
    const actor = watch(ago(5000), { nudge: 1000, stale: 120_000 })
    await waitFor(actor, (s) => s.status === 'done', { timeout: 5000 })

    const queued = await readQueued(RUN)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.intent.kind).toBe('comment_on_issue')
  })

  test('and it rides the answer that released the original question', async () => {
    // Without a gate it would be refused by delivery, and the reporter would
    // never hear from us again.
    const gateId = openGate(handle.sqlite, {
      runId: RUN_ID,
      kind: 'triage',
      artifactVersion: '1',
    })
    answerGate(handle.sqlite, {
      gateId,
      decision: 'approved',
      answeredBy: 'dani',
      answeredOn: 'app',
    })

    const actor = watch(ago(5000), { nudge: 1000, stale: 120_000 })
    await waitFor(actor, (s) => s.status === 'done', { timeout: 5000 })

    const queued = await readQueued(RUN)
    expect(queued[0]?.intent.gateId).toBe(gateId)
  })

  test('silence past the far threshold gives up', async () => {
    const actor = watch(ago(10_000), { nudge: 1000, stale: 2000 })
    // The nudge fires first; this is the state after it, which the machine
    // re-enters and which then reaches the further threshold.
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(['nudged', 'gaveUp']).toContain(settled.value as string)
  })

  test('it does not nudge twice', async () => {
    const actor = watch(ago(5000), { nudge: 1000, stale: 120_000 })
    await waitFor(actor, (s) => s.status === 'done', { timeout: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await readQueued(RUN)).toHaveLength(1)
  })
})

describe('surviving a restart', () => {
  test('everything is measured from when the question was asked', async () => {
    // Not from a timer that died with the process. A run restarted after a week
    // is a week into its wait, not at the beginning of it.
    const actor = watch(ago(5000), { nudge: 1000, stale: 120_000 })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.value).toBe('nudged')
  })

  test('a fresh watch on a question asked moments ago waits', async () => {
    const actor = watch(new Date().toISOString(), {
      nudge: 60_000,
      stale: 120_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(actor.getSnapshot().status).toBe('active')
  })
})
