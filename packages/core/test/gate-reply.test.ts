import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor, fromPromise, setup, waitFor } from 'xstate'
import { openDb } from '@/modules/db/db'
import { answerGate, listGates, readGate } from '@/modules/gates'
import { writeArtifact } from '@/modules/work/artifacts'
import { appendEntry } from '@/modules/work/conversation'
import type { RunRef, Subject } from '@/modules/work/paths'
import { provideRunDeps, releaseRunDeps } from '@/run/machines/deps'
import { gateKeeper } from '@/run/machines/gateActor'
import type { Analysis } from '@/run/stations/schemas'

/**
 * The gate with a conversation in it.
 *
 * The real machine's gate branch, shaped the same way: the keeper invoked on the
 * parent so it survives both substates, and the answer transitions owned by the
 * parent so approving mid conversation is handled without the substates knowing.
 */

let dir: string
let handle: ReturnType<typeof openDb>

// Distinct from every other test file's: run deps are keyed by run id in a
// module level map, so sharing one with another file makes this keeper read that
// file's database.
const SUBJECT: Subject = { repo: 'acme/replies', kind: 'issue', number: 31 }
const RUN_ID = 'acme/replies#31@1790000000031'
const RUN: RunRef = { subject: SUBJECT, runId: RUN_ID }

const REVISED: Analysis = {
  problem_statement: 'p',
  approach: 'streamed',
  plan: ['stream it'],
  affected_surface: [],
  risks: [],
  acceptance_criteria: ['the signature is unchanged'],
  test_strategy: 't',
}

/** Records what the reply turn was asked, so the test can assert on it. */
let asked: { entryId: string; question: string }[] = []
/** What the fake turn does: talk, revise, fail, or hang. */
let behaviour: 'talk' | 'revise' | 'fail' | 'hang' | 'slow' = 'talk'

/**
 * Sleeps, unless the actor is stopped first.
 *
 * A turn that keeps running after its actor is stopped appends into whatever
 * state directory the next test has set up, which changes that test's
 * conversation and fails it for reasons that have nothing to do with it.
 */
function nap(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('stopped'))
    })
  })
}

const fakeReplier = fromPromise(
  async ({
    input,
    signal,
  }: {
    input: { runId: string; entryId: string; question: string }
    signal: AbortSignal
  }): Promise<{ analysis?: Analysis }> => {
    asked.push({ entryId: input.entryId, question: input.question })
    if (behaviour === 'hang') {
      await nap(10_000, signal)
    }
    if (behaviour === 'slow') {
      // Long enough that the next reply lands before this answer does.
      await nap(400, signal)
    }
    if (behaviour === 'fail') {
      throw new Error('the agent gave up')
    }
    if (behaviour === 'revise') {
      // What write_plan does: the next version beside the old one.
      await writeArtifact(SUBJECT, 'plan', '# the revised plan\n')
    }
    // A real turn answers by appending, which is also what clears the pending
    // reply: the last entry stops being the maintainer's.
    await appendEntry(SUBJECT, {
      author: 'analyst',
      role: 'station',
      body: 'because the file does not fit in memory',
    })
    return behaviour === 'revise' ? { analysis: REVISED } : {}
  },
)

function machine() {
  return setup({
    actors: { gateKeeper, replier: fakeReplier },
  }).createMachine({
    id: 'gatingWithReply',
    initial: 'gatingPlan',
    context: {
      decision: '',
      analysis: undefined as Analysis | undefined,
      repliedTo: undefined as string | undefined,
    },
    states: {
      gatingPlan: {
        id: 'gate',
        initial: 'waiting',
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
        states: {
          waiting: {
            on: {
              // Mirrors the real machine: the keeper re-announces an
              // outstanding question every tick, and this guard is what stops
              // that buying a second turn on one already answered.
              REPLY_RECEIVED: {
                target: 'answering',
                guard: ({ context, event }) =>
                  String((event as { entryId?: string }).entryId ?? '') !==
                  context.repliedTo,
                actions: ({ context, event }) => {
                  context.repliedTo = String(
                    (event as { entryId?: string }).entryId ?? '',
                  )
                },
              },
            },
          },
          answering: {
            invoke: {
              src: 'replier',
              input: ({ event }) => ({
                runId: RUN_ID,
                entryId: String((event as { entryId?: string }).entryId ?? ''),
                question: String(
                  (event as { question?: string }).question ?? '',
                ),
              }),
              // Mirrors the real machine: a revision re-enters the gate, which
              // is what retires the old question and opens one on the new bytes.
              onDone: [
                {
                  target: '#gate',
                  reenter: true,
                  guard: ({ event }) =>
                    (event.output as { analysis?: Analysis }).analysis !==
                    undefined,
                  actions: ({ context, event }) => {
                    const output = event.output as { analysis?: Analysis }
                    context.analysis = output.analysis ?? context.analysis
                  },
                },
                { target: 'waiting' },
              ],
              onError: { target: 'waiting' },
            },
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
}

beforeEach(async () => {
  actors = []
  asked = []
  behaviour = 'talk'
  dir = mkdtempSync(join(tmpdir(), 'aalai-reply-'))
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
  for (const actor of actors) {
    actor.stop()
  }
  releaseRunDeps(RUN_ID)
  handle.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Every actor started by a test, stopped in afterEach.
 *
 * A keeper left running polls into the next test and its fake turn appends an
 * answer there, which clears that test's pending reply before its own keeper
 * notices. The symptom is a timeout in an unrelated test, so cleanup is
 * unconditional rather than left to each test remembering.
 */
let actors: { stop: () => void }[] = []

async function parked(): Promise<ReturnType<typeof createActor>> {
  const actor = createActor(machine()).start()
  actors.push(actor)
  await waitFor(
    actor,
    () =>
      listGates(handle.sqlite, { runId: RUN_ID, status: 'open' }).length > 0,
    { timeout: 5000 },
  )
  return actor as ReturnType<typeof createActor>
}

function openGateId(): string {
  const [gate] = listGates(handle.sqlite, { runId: RUN_ID, status: 'open' })
  return gate?.id ?? ''
}

async function reply(body: string): Promise<void> {
  await appendEntry(SUBJECT, { author: 'dani', role: 'maintainer', body })
}

describe('a reply reaches the analyst without answering the gate', () => {
  test('a maintainer entry wakes a turn and the gate stays open', async () => {
    const actor = await parked()
    const gateId = openGateId()
    await reply('why stream rather than buffer?')

    await waitFor(actor, () => asked.length === 1, { timeout: 5000 })
    expect(asked[0]?.question).toBe('why stream rather than buffer?')

    const gate = readGate(handle.sqlite, gateId)
    expect(gate?.status).toBe('open')
    expect(gate?.decision).toBeNull()
  })

  test('the turn is told which entry it is answering', async () => {
    const actor = await parked()
    await reply('first question')
    await waitFor(actor, () => asked.length === 1, { timeout: 5000 })
    expect(asked[0]?.entryId).not.toBe('')
  })

  test('the gate keeps its artifact version across a reply', async () => {
    const actor = await parked()
    const before = readGate(handle.sqlite, openGateId())
    await reply('a question')
    await waitFor(actor, () => asked.length === 1, { timeout: 5000 })
    const after = readGate(handle.sqlite, openGateId())
    expect(after?.artifactVersion).toBe(before?.artifactVersion as string)
    expect(after?.openedAt).toBe(before?.openedAt as string)
  })

  test('it returns to waiting, so a second reply is answered too', async () => {
    const actor = await parked()
    await reply('first')
    await waitFor(actor, () => asked.length === 1, { timeout: 5000 })
    await reply('second')
    await waitFor(actor, () => asked.length === 2, { timeout: 5000 })
    expect(asked.map((a) => a.question)).toEqual(['first', 'second'])
  })

  test('a reply sent while the analyst is answering is not buried by the answer', async () => {
    // The keeper used to look at the last entry only. A question asked mid turn
    // stopped being last as soon as the answer to the previous one was appended
    // after it, so it was never announced and the person waited forever.
    behaviour = 'slow'
    const actor = await parked()
    await reply('first')
    await waitFor(actor, () => asked.length === 1, { timeout: 5000 })
    // Sent while the first turn is still running, so the answer to it lands
    // after this one.
    await reply('second, asked while it was still thinking')
    await waitFor(actor, () => asked.length === 2, { timeout: 8000 })
    expect(asked[1]?.question).toBe('second, asked while it was still thinking')
  })

  test('one reply buys exactly one turn, however often the poll runs', async () => {
    const actor = await parked()
    await reply('only once please')
    await waitFor(actor, () => asked.length === 1, { timeout: 5000 })
    // Several poll intervals, with the answer already appended.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(asked).toHaveLength(1)
  })
})

describe('a reply that revises the plan', () => {
  test('the revised analysis is adopted', async () => {
    behaviour = 'revise'
    const actor = await parked()
    await reply('keep the existing signature')
    await waitFor(actor, (state) => state.context.analysis !== undefined, {
      timeout: 5000,
    })
    expect(actor.getSnapshot().context.analysis?.approach).toBe('streamed')
  })

  test('the gate asked about the old plan is retired, without being told to', async () => {
    // Found in review. `supersedeOpenGates` runs only when the gate state is
    // entered, and returning from a reply is a transition between substates, so
    // nothing retired the old question: the run stayed on the v1 gate while the
    // context held v2, and approving it would have built a plan nobody approved.
    // The previous version of this test called supersedeOpenGates by hand, so it
    // proved the mechanism and never touched the path.
    behaviour = 'revise'
    const actor = await parked()
    const firstGate = openGateId()
    await reply('keep the existing signature')
    await waitFor(actor, () => asked.length === 1, { timeout: 5000 })

    await waitFor(
      actor,
      () => readGate(handle.sqlite, firstGate)?.status === 'superseded',
      { timeout: 8000 },
    )
    expect(readGate(handle.sqlite, firstGate)?.status).toBe('superseded')
  })

  test('and a new gate opens on the revised plan', async () => {
    behaviour = 'revise'
    const actor = await parked()
    const firstGate = openGateId()
    await reply('keep the existing signature')
    await waitFor(actor, () => asked.length === 1, { timeout: 5000 })

    const reopened = await waitFor(
      actor,
      () => {
        const open = listGates(handle.sqlite, {
          runId: RUN_ID,
          status: 'open',
        })
        return open.length === 1 && open[0]?.id !== firstGate
      },
      { timeout: 8000 },
    )
    expect(reopened).toBeDefined()
    const [open] = listGates(handle.sqlite, { runId: RUN_ID, status: 'open' })
    // Pinned to the bytes that now stand, which is what makes approving it mean
    // approving what the person just negotiated.
    expect(open?.artifactVersion).toBe('2')
  })

  test('approving the reopened gate approves the revised analysis', async () => {
    behaviour = 'revise'
    const actor = await parked()
    const firstGate = openGateId()
    await reply('keep the existing signature')
    await waitFor(
      actor,
      () =>
        listGates(handle.sqlite, { runId: RUN_ID, status: 'open' })[0]?.id !==
        firstGate,
      { timeout: 8000 },
    )
    const [open] = listGates(handle.sqlite, { runId: RUN_ID, status: 'open' })
    answerGate(handle.sqlite, {
      gateId: open?.id ?? '',
      decision: 'approved',
      answeredBy: 'dani',
      answeredOn: 'app',
    })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 8000,
    })
    expect(settled.value).toBe('settled')
    // The context carries what was approved, not what was superseded.
    expect(settled.context.analysis?.approach).toBe('streamed')
  })
})

describe('a person and the analyst acting at once', () => {
  test('approving mid answer still wins, because the parent owns the answer', async () => {
    behaviour = 'hang'
    const actor = await parked()
    const gateId = openGateId()
    await reply('a question the analyst is slow about')
    await waitFor(actor, () => asked.length === 1, { timeout: 5000 })
    expect(actor.getSnapshot().value).toEqual({ gatingPlan: 'answering' })

    // The maintainer decides without waiting for the answer.
    const result = answerGate(handle.sqlite, {
      gateId,
      decision: 'approved',
      answeredBy: 'dani',
      answeredOn: 'app',
    })
    expect(result.ok).toBe(true)

    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.value).toBe('settled')
    expect(settled.context.decision).toBe('approved')
  })

  test('a failed answer leaves the gate open rather than failing the run', async () => {
    behaviour = 'fail'
    const actor = await parked()
    const gateId = openGateId()
    await reply('a question that goes wrong')
    await waitFor(actor, () => asked.length === 1, { timeout: 5000 })
    await waitFor(
      actor,
      (state) => JSON.stringify(state.value) === '{"gatingPlan":"waiting"}',
      { timeout: 5000 },
    )
    expect(readGate(handle.sqlite, gateId)?.status).toBe('open')
  })
})

describe('what does not count as a reply', () => {
  test("a station's own note does not wake a turn", async () => {
    const _actor = await parked()
    await appendEntry(SUBJECT, {
      author: 'analyst',
      role: 'station',
      body: 'a note to itself',
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(asked).toHaveLength(0)
  })

  test('an already answered reply does not wake one on restart', async () => {
    // The conversation reconciles itself: the analyst's answer is the last
    // entry, so nothing is pending and a restarted keeper asks for nothing.
    await appendEntry(SUBJECT, {
      author: 'dani',
      role: 'maintainer',
      body: 'asked earlier',
    })
    await appendEntry(SUBJECT, {
      author: 'analyst',
      role: 'station',
      body: 'answered earlier',
    })
    const _actor = await parked()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(asked).toHaveLength(0)
  })

  test('a question left over from an earlier gate is not re-answered', async () => {
    // Found in review. The conversation belongs to the subject and outlives any
    // one gate, so a question nobody answered before a gate was approved is
    // still the last thing said. A later run on the same subject used to treat
    // it as its own and spend a turn on it.
    await appendEntry(SUBJECT, {
      author: 'dani',
      role: 'maintainer',
      body: 'asked during a gate that was then approved',
    })
    // A second apart, so the entry is unambiguously older than the gate.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const actor = await parked()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(asked).toHaveLength(0)
    void actor
  })

  test('a reply left unanswered when the app died is picked up on restart', async () => {
    await appendEntry(SUBJECT, {
      author: 'dani',
      role: 'maintainer',
      body: 'asked before the crash',
    })
    const actor = await parked()
    await waitFor(actor, () => asked.length === 1, { timeout: 5000 })
    expect(asked[0]?.question).toBe('asked before the crash')
  })
})
