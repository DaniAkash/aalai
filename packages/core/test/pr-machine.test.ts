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
    actor.send({ type: 'SIGNALS', signals: [touched] })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('handedBack')
  })

  test('even when a check is failing beside it', async () => {
    // The answer to a failing check is a push, and this is the one signal
    // that forbids one.
    const actor = start()
    actor.send({ type: 'SIGNALS', signals: [failing, touched] })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('handedBack')
  })
})

describe('whose fault a failing check is', () => {
  test('somebody else’s is said out loud and then watched again', async () => {
    const actor = start()
    actor.send({ type: 'SIGNALS', signals: [failing] })
    const back = await waitFor(
      actor,
      (s) => s.matches('watching') && s.context.pending.length === 0,
      {
        timeout: 5000,
      },
    )
    // Still running: their outage gets fixed by them, and the next look is green.
    expect(back.status).toBe('active')
  })

  test('and no fix is spent on it', async () => {
    const actor = start()
    actor.send({ type: 'SIGNALS', signals: [failing] })
    const back = await waitFor(
      actor,
      (s) => s.matches('watching') && s.context.pending.length === 0,
      { timeout: 5000 },
    )
    expect(back.context.ciFixes).toBe(0)
  })

  test('ours is fixed, and the fix is what gets pushed', async () => {
    const actor = start({ faultClassifier: ourFault })
    actor.send({ type: 'SIGNALS', signals: [failing] })
    const back = await waitFor(
      actor,
      (s) => s.matches('watching') && s.context.pushedSha !== '',
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
    actor.send({ type: 'SIGNALS', signals: [failing] })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('failed')
  })

  test('a fix is spent only when the failure was ours', async () => {
    // A classification deciding somebody else broke it costs nothing, which is
    // the entire reason the classification happens before the fix.
    const actor = start()
    actor.send({ type: 'SIGNALS', signals: [failing] })
    const back = await waitFor(
      actor,
      (s) => s.matches('watching') && s.context.pending.length === 0,
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
    actor.send({ type: 'SIGNALS', signals: [failing] })
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
    actor.send({ type: 'SIGNALS', signals: [moved] })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('exhausted')
    expect(
      settled.context.outcome?.kind === 'exhausted' &&
        settled.context.outcome.why,
    ).toContain('base branch moved')
  })

  test('a review comment stops with a reason rather than being dropped', async () => {
    const actor = start()
    actor.send({ type: 'SIGNALS', signals: [asked] })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(
      settled.context.outcome?.kind === 'exhausted' &&
        settled.context.outcome.why,
    ).toContain('review comment')
  })
})

describe('the budgets', () => {
  test('a pull request out of ci fixes stops, and says which ran out', async () => {
    const actor = start({}, { maxCiFixes: 0 })
    actor.send({ type: 'SIGNALS', signals: [failing] })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('exhausted')
  })

  test('having no revisions left does not stop a check being looked at', async () => {
    // The two draw from different pools, which is the whole reason there are
    // two of them.
    const actor = start({}, { maxRevisions: 0 })
    actor.send({ type: 'SIGNALS', signals: [failing] })
    const back = await waitFor(
      actor,
      (s) => s.matches('watching') && s.context.pending.length === 0,
      { timeout: 5000 },
    )
    expect(back.status).toBe('active')
  })
})

describe('a pull request that is no longer open', () => {
  test('ends the run', async () => {
    const actor = start()
    actor.send({ type: 'PR_GONE' })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('settled')
  })
})
