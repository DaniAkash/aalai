import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor, fromPromise, waitFor } from 'xstate'
import { openDb } from '@/modules/db/db'
import { answerGate, listGates } from '@/modules/gates'
import type { DeliveryReport } from '@/modules/outbound/deliver'
import { writeArtifact } from '@/modules/work/artifacts'
import { readConversation } from '@/modules/work/conversation'
import type { RunRef, Subject } from '@/modules/work/paths'
import { queueOutbound, readQueued } from '@/modules/work/store'
import { provideRunDeps, releaseRunDeps } from '@/run/machines/deps'
import { triageMachine } from '@/run/machines/triage'
import type { Triage } from '@/run/stations/schemas'
import { triageSchema } from '@/run/stations/schemas'

/**
 * The triage machine, with the classifier and the network stubbed.
 *
 * What is asserted here is the shape of the decision: where a security report
 * goes, what a reclassification does, and above all that nothing is delivered
 * until a person has answered. The classifier's judgement is the model's
 * business and is not what these tests are about.
 */

let dir: string
let handle: ReturnType<typeof openDb>

const SUBJECT: Subject = { repo: 'acme/triage', kind: 'issue', number: 51 }
const RUN_ID = 'acme/triage#51@1790000000051'
const RUN: RunRef = { subject: SUBJECT, runId: RUN_ID }

let classified: Triage[] = []
let delivered: string[] = []
let generations: number[] = []

function triage(overrides: Partial<Triage> = {}): Triage {
  return triageSchema.parse({
    classification: 'bug',
    confidence: 'high',
    summary: 'the importer drops rows',
    reasoning: 'a version and a reproduction are given',
    affected_surface: ['src/import.ts'],
    missing: [],
    ...overrides,
  })
}

/**
 * The real machine, with only the expensive parts replaced.
 *
 * Not a machine shaped like it. A harness that mirrors production stops
 * mirroring it the moment production changes, and this one had already drifted
 * twice before it was written down: the states, the guards and the transitions
 * here are the ones that ship, and only the actors that cost money or touch the
 * network are swapped out.
 */
function machine(verdicts: Triage[]) {
  let call = 0
  return triageMachine.provide({
    actors: {
      classifier: fromPromise(
        async ({
          input,
        }: {
          input: { runId: string; issueNumber: number; generation: number }
        }) => {
          generations.push(input.generation)
          const verdict = verdicts[call] ?? verdicts[verdicts.length - 1]
          call += 1
          const value = verdict ?? triage()
          classified.push(value)
          // What write_triage does, so the gate has an artifact to pin to.
          await writeArtifact(
            SUBJECT,
            'triage',
            `# Triage\n\n${value.classification}\n`,
          )
          return value
        },
      ),
      replier: fromPromise(async () => ({})),
      deliverer: fromPromise(async (): Promise<DeliveryReport> => {
        delivered.push('ran')
        return { delivered: [], refused: [], failed: [] }
      }),
    },
  })
}

function openGateId(): string {
  const [gate] = listGates(handle.sqlite, { runId: RUN_ID, status: 'open' })
  return gate?.id ?? ''
}

let actors: { stop: () => void }[] = []

async function start(verdicts: Triage[]) {
  const actor = createActor(machine(verdicts), {
    input: {
      runId: RUN_ID,
      repo: SUBJECT.repo,
      issueNumber: SUBJECT.number,
      gatePollMs: 25,
    },
  }).start()
  actors.push(actor)
  return actor
}

beforeEach(() => {
  actors = []
  classified = []
  delivered = []
  generations = []
  dir = mkdtempSync(join(tmpdir(), 'aalai-triage-'))
  process.env.AALAI_STATE_DIR = dir
  handle = openDb(join(dir, 'aalai.sqlite'))
  provideRunDeps(RUN_ID, {
    db: handle.sqlite,
    run: RUN,
    repo: SUBJECT.repo,
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

describe('a security report never reaches a gate', () => {
  test('it escalates instead of asking anyone to approve a reply', async () => {
    // There is nothing to approve: approving would mean approving a public
    // answer, and a public answer is the leak.
    const actor = await start([triage({ classification: 'security' })])
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.value).toBe('escalated')
    expect(listGates(handle.sqlite, { runId: RUN_ID })).toHaveLength(0)
  })

  test('nothing is delivered for it, ever', async () => {
    const actor = await start([triage({ classification: 'security' })])
    await waitFor(actor, (s) => s.status === 'done', { timeout: 5000 })
    expect(delivered).toHaveLength(0)
  })

  test('a drafted reply on one does not change that', async () => {
    const actor = await start([
      triage({
        classification: 'security',
        reply: 'thanks, we are looking into it',
      }),
    ])
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.value).toBe('escalated')
    expect(delivered).toHaveLength(0)
  })
})

describe('what a person decides', () => {
  test('an approved bug hands off to be worked on', async () => {
    const actor = await start([triage({ classification: 'bug' })])
    await waitFor(actor, () => openGateId() !== '', { timeout: 5000 })
    answerGate(handle.sqlite, {
      gateId: openGateId(),
      decision: 'approved',
      answeredBy: 'dani',
      answeredOn: 'app',
    })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.value).toBe('handingOff')
    // Nothing was said: the run is what happens next, not a comment.
    expect(delivered).toHaveLength(0)
  })

  test('an approved question delivers what was drafted', async () => {
    const actor = await start([triage({ classification: 'question' })])
    await waitFor(actor, () => openGateId() !== '', { timeout: 5000 })
    answerGate(handle.sqlite, {
      gateId: openGateId(),
      decision: 'approved',
      answeredBy: 'dani',
      answeredOn: 'app',
    })
    await waitFor(actor, (s) => s.status === 'done', { timeout: 5000 })
    expect(delivered).toEqual(['ran'])
  })

  test('a rejection delivers too, because the reason is the comment', async () => {
    const actor = await start([triage({ classification: 'bug' })])
    await waitFor(actor, () => openGateId() !== '', { timeout: 5000 })
    answerGate(handle.sqlite, {
      gateId: openGateId(),
      decision: 'rejected',
      reason: 'not something we want',
      answeredBy: 'dani',
      answeredOn: 'app',
    })
    await waitFor(actor, (s) => s.status === 'done', { timeout: 5000 })
    expect(delivered).toEqual(['ran'])
  })
})

describe('reclassifying', () => {
  test('it classifies again rather than closing or accepting', async () => {
    const actor = await start([
      triage({ classification: 'bug' }),
      triage({ classification: 'question' }),
    ])
    await waitFor(actor, () => openGateId() !== '', { timeout: 5000 })
    answerGate(handle.sqlite, {
      gateId: openGateId(),
      decision: 'reclassify',
      reason: 'this is a question, they are asking how to configure it',
      answeredBy: 'dani',
      answeredOn: 'app',
    })
    await waitFor(actor, () => classified.length === 2, { timeout: 8000 })
    expect(classified[1]?.classification).toBe('question')
  })

  test('the correction is written where the next pass will read it', async () => {
    const actor = await start([
      triage({ classification: 'bug' }),
      triage({ classification: 'question' }),
    ])
    await waitFor(actor, () => openGateId() !== '', { timeout: 5000 })
    answerGate(handle.sqlite, {
      gateId: openGateId(),
      decision: 'reclassify',
      reason: 'this is a question, they are asking how to configure it',
      answeredBy: 'dani',
      answeredOn: 'app',
    })
    await waitFor(actor, () => classified.length === 2, { timeout: 8000 })

    const said = await readConversation(SUBJECT)
    expect(said.at(-1)?.role).toBe('maintainer')
    expect(said.at(-1)?.body).toContain('asking how to configure it')
  })

  test('it is a new judgement, so it buys its own turn', async () => {
    // Keyed on the generation rather than retried: a restart of the first
    // judgement must not run again, and a second judgement must.
    const actor = await start([
      triage({ classification: 'bug' }),
      triage({ classification: 'question' }),
    ])
    await waitFor(actor, () => openGateId() !== '', { timeout: 5000 })
    answerGate(handle.sqlite, {
      gateId: openGateId(),
      decision: 'reclassify',
      reason: 'wrong',
      answeredBy: 'dani',
      answeredOn: 'app',
    })
    await waitFor(actor, () => generations.length === 2, { timeout: 8000 })
    expect(generations).toEqual([0, 1])
  })
})

describe('what the classifier queued is bound to the question', () => {
  test('an intent queued before the gate existed gets the gate', async () => {
    await queueOutbound(RUN, {
      kind: 'comment_on_issue',
      body: 'is this the same as #12?',
      station: 'classifier',
      queuedAt: new Date().toISOString(),
    })
    const actor = await start([triage({ classification: 'duplicate' })])
    await waitFor(actor, () => openGateId() !== '', { timeout: 5000 })

    for (let i = 0; i < 60; i += 1) {
      const [queued] = await readQueued(RUN)
      if (queued?.intent.gateId !== undefined) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const [queued] = await readQueued(RUN)
    expect(queued?.intent.gateId).toBe(openGateId())
  })
})
