import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createActor, fromCallback, fromPromise, waitFor } from 'xstate'
import { prLifecycle } from '@/run/machines/prLifecycle'
import type { Signal } from '@/run/prSignals'
import type { FaultVerdict } from '@/run/stations/schemas'

/**
 * The machine that keeps a pull request alive.
 *
 * Driven through the real machine with its actors stubbed, rather than through
 * a copy of it. A hand written mirror of a machine drifts from the one that
 * ships, and the drift is invisible until something that only the copy does
 * goes wrong in production.
 */

let actors: { stop: () => void }[] = []

function start(
  overrides: Record<string, unknown> = {},
  input: Record<string, unknown> = {},
) {
  const actor = createActor(
    prLifecycle.provide({
      actors: {
        prWatch: fromCallback(() => () => {}),
        faultClassifier: fromPromise(
          async (): Promise<FaultVerdict> => ({
            fault: 'theirs',
            summary: 'the registry was unreachable',
            reasoning: 'nothing in the diff touches the network',
            evidence: ['registry unreachable'],
          }),
        ),
        failureReporter: fromPromise(async () => {}),
        ciFixer: fromPromise(async () => ({ pushedSha: 'fixed-sha' })),
        reviewAnswerer: fromPromise(
          async (): Promise<{ pushedSha: string | null }> => ({
            pushedSha: 'answer-sha',
          }),
        ),
        ...overrides,
      },
    }),
    {
      input: {
        runId: 'acme/widgets#7@1790000000007',
        repo: 'acme/widgets',
        prNumber: 7,
        maxCiFixes: 2,
        maxRevisions: 2,
        windowMs: 10,
        ...input,
      },
    },
  ).start()
  actors.push(actor)
  return actor
}

/** One look, the way the watch reports one. */
function look(
  actor: { send: (event: never) => void },
  signals: readonly Signal[],
) {
  actor.send({
    type: 'LOOKED',
    signals,
    seen: {
      looked: true,
      headSha: 'aaa',
      baseSha: 'base1',
      lastCommentId: 0,
      failedChecks: [],
      pushedSha: 'aaa',
    },
  } as never)
}

const ourFault = fromPromise(
  async (): Promise<FaultVerdict> => ({
    fault: 'ours',
    summary: 'the teens case is not handled',
    reasoning: 'the failing assertion names the function this diff edits',
    evidence: ['(fail) uses th for the teens'],
  }),
)

const failing: Signal = { kind: 'checks_failed', names: ['test'] }
const touched: Signal = { kind: 'branch_touched', author: 'a-maintainer' }
const moved: Signal = { kind: 'base_moved', baseSha: 'base2' }
const asked: Signal = { kind: 'comments', comments: [] }

beforeEach(() => {
  actors = []
})

afterEach(() => {
  for (const actor of actors) {
    actor.stop()
  }
})

describe('a branch somebody else touched', () => {
  test('stops the run rather than pushing over them', async () => {
    const actor = start()
    look(actor, [touched])
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('handedBack')
  })

  test('even when a check is failing beside it', async () => {
    // The answer to a failing check is a push, and this is the one signal
    // that forbids one.
    const actor = start()
    look(actor, [failing, touched])
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('handedBack')
  })
})

describe('whose fault a failing check is', () => {
  test('somebody else’s is said out loud and then watched again', async () => {
    const actor = start()
    look(actor, [failing])
    const back = await waitFor(
      actor,
      (s) => s.value === 'watching' && s.context.pending.length === 0,
      {
        timeout: 5000,
      },
    )
    // Still running: their outage gets fixed by them, and the next look is green.
    expect(back.status).toBe('active')
  })

  test('and no fix is spent on it', async () => {
    const actor = start()
    look(actor, [failing])
    const back = await waitFor(
      actor,
      (s) => s.value === 'watching' && s.context.pending.length === 0,
      { timeout: 5000 },
    )
    expect(back.context.ciFixes).toBe(0)
  })

  test('ours is fixed, and the fix is what gets pushed', async () => {
    const actor = start({ faultClassifier: ourFault })
    look(actor, [failing])
    const back = await waitFor(
      actor,
      (s) => s.value === 'watching' && s.context.pushedSha !== '',
      { timeout: 5000 },
    )
    expect(back.context.pushedSha).toBe('fixed-sha')
    expect(back.context.ciFixes).toBe(1)
  })

  test('a fix that changed nothing stops rather than trying the same thing again', async () => {
    // The attempt is already spent. Going back to watch the same check fail
    // for the same reason is how a budget is burned without a person learning
    // anything.
    const actor = start({
      faultClassifier: ourFault,
      ciFixer: fromPromise(async () => {
        throw new Error('the fix changed nothing (no-changes)')
      }),
    })
    look(actor, [failing])
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('failed')
  })

  test('a fix is spent only when the failure was ours', async () => {
    // A classification deciding somebody else broke it costs nothing, which is
    // the entire reason the classification happens before the fix.
    const actor = start()
    look(actor, [failing])
    const back = await waitFor(
      actor,
      (s) => s.value === 'watching' && s.context.pending.length === 0,
      { timeout: 5000 },
    )
    expect(back.context.ciFixes).toBe(0)
  })

  test('a classifier that cannot answer fails the run rather than guessing', async () => {
    const actor = start({
      faultClassifier: fromPromise(async () => {
        throw new Error('the agent went away')
      }),
    })
    look(actor, [failing])
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('failed')
  })
})

describe('what is not built yet says so', () => {
  test('a moved base stops with a reason rather than clearing the batch', async () => {
    // Silently dropping it leaves a pull request that can never merge looking
    // perfectly healthy, which is the failure shape this phase keeps finding.
    const actor = start()
    look(actor, [moved])
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('exhausted')
    expect(
      settled.context.outcome?.kind === 'exhausted' &&
        settled.context.outcome.why,
    ).toContain('base branch moved')
  })
})

describe('answering a review', () => {
  test('a review comment is answered rather than ending the pull request', async () => {
    // This used to stop with "that is not built yet". It is built now, and
    // the thing that would quietly undo it is this transition going back to
    // done, so the test watches for the state rather than the outcome.
    const actor = start()
    look(actor, [asked])
    const answering = await waitFor(
      actor,
      (s) => s.matches('answeringReview'),
      { timeout: 5000 },
    )
    expect(answering.matches('answeringReview')).toBe(true)
  })

  test('answering goes back to watching, because a review is not the end', async () => {
    // The push it may have made starts the checks again, and whoever reads the
    // answer may say something else.
    const actor = start()
    look(actor, [asked])
    const watching = await waitFor(actor, (s) => s.matches('watching'), {
      timeout: 5000,
    })
    expect(watching.context.pushedSha).toBe('answer-sha')
  })

  test('a push it did not make leaves the last one alone', async () => {
    // Answering by disagreeing with every comment changes nothing, and the
    // previous push is still the last thing this factory pushed. Blanking it
    // would make the next look read our own last commit as somebody else
    // touching the branch, which stops the run.
    const actor = start({
      reviewAnswerer: fromPromise(
        async (): Promise<{ pushedSha: string | null }> => ({
          pushedSha: null,
        }),
      ),
    })
    look(actor, [asked])
    const watching = await waitFor(actor, (s) => s.matches('watching'), {
      timeout: 5000,
    })
    // What the look established, not blanked by an answer that pushed nothing.
    expect(watching.context.pushedSha).toBe('aaa')
  })
})

describe('the budgets', () => {
  test('a pull request out of ci fixes stops, and says which ran out', async () => {
    const actor = start({}, { maxCiFixes: 0 })
    look(actor, [failing])
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('exhausted')
  })

  test('having no revisions left does not stop a check being looked at', async () => {
    // The two draw from different pools, which is the whole reason there are
    // two of them.
    const actor = start({}, { maxRevisions: 0 })
    look(actor, [failing])
    const back = await waitFor(
      actor,
      (s) => s.value === 'watching' && s.context.pending.length === 0,
      { timeout: 5000 },
    )
    expect(back.status).toBe('active')
  })
})

describe('a pull request that is no longer open', () => {
  test('ends the run, saying which way it went', async () => {
    const actor = start()
    actor.send({ type: 'PR_CLOSED', state: 'MERGED' } as never)
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('closed')
    expect(
      settled.context.outcome?.kind === 'closed' &&
        settled.context.outcome.state,
    ).toBe('MERGED')
  })

  test('one closed without merging is not reported as green', async () => {
    // It can be closed with its checks red, and calling that settled would
    // describe the opposite of what happened.
    const actor = start()
    actor.send({ type: 'PR_CLOSED', state: 'CLOSED' } as never)
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).not.toBe('settled')
  })
})

describe('the answering budget', () => {
  test('answering a review spends a revision', async () => {
    // Without this the allowance never advances, and a push that a bot
    // reviewer answers with more comments is a loop rather than a round.
    const actor = start()
    look(actor, [asked])
    const watching = await waitFor(actor, (s) => s.matches('watching'), {
      timeout: 5000,
    })
    expect(watching.context.revisions).toBe(1)
  })
})
