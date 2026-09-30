import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor, fromPromise, waitFor } from 'xstate'
import { openDb } from '@/modules/db/db'
import { answerGate } from '@/modules/gates'
import type { RunRef, Subject } from '@/modules/work/paths'
import type { ExecutionVerdict } from '@/run/executionTrust'
import { provideRunDeps, releaseRunDeps } from '@/run/machines/deps'
import { prReview } from '@/run/machines/prReview'
import type { RanTests } from '@/run/machines/reviewActors'

/** What the sizer and the head check hand back, so a stub matches the real one. */
type Sized = { headSha: string } & (
  | { reviewable: true }
  | { reviewable: false; why: string }
)
type Looked = {
  moved: boolean
  headSha: string
  headRepo: string
  state: string
}

/**
 * Reviewing somebody else's pull request.
 *
 * Driven through the real machine with its actors stubbed. The property worth
 * most here is that reading happens before the question of running, and that
 * nothing runs unless a person said so, so both are asserted by what order the
 * states are visited in rather than by reading the code.
 */

const SUBJECT: Subject = { repo: 'acme/widgets', kind: 'pr', number: 64 }
const RUN_ID = 'acme/widgets#64@1790000000064'
const RUN: RunRef = { subject: SUBJECT, runId: RUN_ID }

let dir: string
let handle: ReturnType<typeof openDb>
let actors: { stop: () => void }[] = []
let visited: string[] = []

function start(overrides: Record<string, unknown> = {}) {
  const actor = createActor(
    prReview.provide({
      actors: {
        sizer: fromPromise(
          async (): Promise<Sized> => ({
            headSha: 'head1',
            reviewable: true,
          }),
        ),
        executionScreen: fromPromise(
          async (): Promise<ExecutionVerdict> => ({
            allowed: false,
            reason: 'a commit by an account this repository does not know',
          }),
        ),
        staticReviewer: fromPromise(async () => {}),
        dynamicReviewer: fromPromise(
          async (): Promise<RanTests> => ({
            ran: true,
            passed: true,
            output: ' 1 pass\n 0 fail',
          }),
        ),
        headWatch: fromPromise(
          async (): Promise<Looked> => ({
            moved: false,
            headSha: 'head1',
            headRepo: 'acme/widgets',
            state: 'OPEN',
          }),
        ),
        ...overrides,
      },
    }),
    {
      input: {
        runId: RUN_ID,
        repo: SUBJECT.repo,
        prNumber: 64,
        title: 'a contribution',
        gatePollMs: 25,
      },
    },
  ).start()
  visited = []
  actor.subscribe((s) => {
    const v = String(s.value)
    if (visited[visited.length - 1] !== v) visited.push(v)
  })
  actors.push(actor)
  return actor
}

beforeEach(() => {
  actors = []
  dir = mkdtempSync(join(tmpdir(), 'aalai-review-'))
  process.env.AALAI_STATE_DIR = dir
  handle = openDb(join(dir, 'aalai.sqlite'))
  provideRunDeps(RUN_ID, {
    db: handle.sqlite,
    run: RUN,
    repo: SUBJECT.repo,
  } as never)
})

afterEach(() => {
  for (const actor of actors) actor.stop()
  releaseRunDeps(RUN_ID)
  handle.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('a stranger’s pull request', () => {
  test('is read before anybody is asked whether to run it', async () => {
    // The order is the design: a question about running code cannot be answered
    // by somebody who has not been told what the code does.
    const actor = start()
    await waitFor(actor, (s) => s.matches('askingToRun'), { timeout: 5000 })
    expect(visited.indexOf('reading')).toBeGreaterThan(-1)
    expect(visited.indexOf('reading')).toBeLessThan(
      visited.indexOf('askingToRun'),
    )
  })

  test('and is not run when nobody says it may', async () => {
    const actor = start()
    await waitFor(actor, (s) => s.context.gateId !== undefined, {
      timeout: 5000,
    })
    answerGate(handle.sqlite, {
      gateId: actor.getSnapshot().context.gateId ?? '',
      decision: 'rejected',
      answeredBy: 'dani',
      answeredOn: 'app',
    })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('readOnly')
    expect(visited).not.toContain('checkingHead')
  })

  test('a read that was never run is a complete result, not a failure', async () => {
    const actor = start()
    await waitFor(actor, (s) => s.context.gateId !== undefined, {
      timeout: 5000,
    })
    answerGate(handle.sqlite, {
      gateId: actor.getSnapshot().context.gateId ?? '',
      decision: 'rejected',
      answeredBy: 'dani',
      answeredOn: 'app',
    })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).not.toBe('failed')
  })
})

describe('a trusted contributor’s pull request', () => {
  test('skips the gate entirely', async () => {
    const actor = start({
      executionScreen: fromPromise(
        async (): Promise<ExecutionVerdict> => ({ allowed: true }),
      ),
    })
    await waitFor(actor, (s) => s.status === 'done', { timeout: 5000 })
    expect(visited).not.toContain('askingToRun')
  })

  test('and is still read first', async () => {
    const actor = start({
      executionScreen: fromPromise(
        async (): Promise<ExecutionVerdict> => ({ allowed: true }),
      ),
    })
    await waitFor(actor, (s) => s.status === 'done', { timeout: 5000 })
    expect(visited.indexOf('reading')).toBeLessThan(
      visited.indexOf('checkingHead'),
    )
  })
})

describe('what happens before anything runs', () => {
  test('a head that moved since the review makes it stale', async () => {
    // A person cleared a head for running. A force push means what they cleared
    // is not what is there.
    const actor = start({
      executionScreen: fromPromise(
        async (): Promise<ExecutionVerdict> => ({ allowed: true }),
      ),
      headWatch: fromPromise(
        async (): Promise<Looked> => ({
          moved: true,
          headSha: 'head2',
          headRepo: 'acme/widgets',
          state: 'OPEN',
        }),
      ),
    })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('stale')
  })

  test('a pull request closed mid review stops without a verdict', async () => {
    const actor = start({
      executionScreen: fromPromise(
        async (): Promise<ExecutionVerdict> => ({ allowed: true }),
      ),
      headWatch: fromPromise(
        async (): Promise<Looked> => ({
          moved: false,
          headSha: 'head1',
          headRepo: 'acme/widgets',
          state: 'MERGED',
        }),
      ),
    })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('gone')
  })
})

describe('what is declined outright', () => {
  test('a change too large to review never reaches an agent', async () => {
    const actor = start({
      sizer: fromPromise(
        async (): Promise<Sized> => ({
          headSha: 'head1',
          reviewable: false,
          why: 'this changes 3000 lines. Splitting it would help.',
        }),
      ),
    })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('declined')
    expect(visited).not.toContain('reading')
  })

  test('and says why, in something a person can act on', async () => {
    const actor = start({
      sizer: fromPromise(
        async (): Promise<Sized> => ({
          headSha: 'head1',
          reviewable: false,
          why: 'this changes 3000 lines. Splitting it would help.',
        }),
      ),
    })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(
      settled.context.outcome?.kind === 'declined' &&
        settled.context.outcome.why,
    ).toContain('Splitting')
  })
})

describe('when trust cannot be established', () => {
  test('it is asked rather than assumed', async () => {
    // Not knowing whether code may run is the same as it not being allowed to.
    const actor = start({
      executionScreen: fromPromise(async () => {
        throw new Error('github was unreachable')
      }),
    })
    await waitFor(actor, (s) => s.matches('askingToRun'), { timeout: 5000 })
    expect(actor.getSnapshot().context.execution?.allowed).toBe(false)
  })
})

describe('running somebody else’s tests', () => {
  const trusted = {
    executionScreen: fromPromise(
      async (): Promise<ExecutionVerdict> => ({ allowed: true }),
    ),
  }

  test('happens for a trusted contributor, and reports what they said', async () => {
    const actor = start(trusted)
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('reviewed')
    expect(settled.context.tests?.passed).toBe(true)
  })

  test('happens for a stranger only once somebody said it may', async () => {
    const actor = start()
    await waitFor(actor, (s) => s.context.gateId !== undefined, {
      timeout: 5000,
    })
    expect(visited).not.toContain('running')
    answerGate(handle.sqlite, {
      gateId: actor.getSnapshot().context.gateId ?? '',
      decision: 'approved',
      answeredBy: 'dani',
      answeredOn: 'app',
    })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(visited).toContain('running')
    expect(settled.context.outcome?.kind).toBe('reviewed')
  })

  test('a suite that cannot be found is said rather than invented', async () => {
    // Guessing a command and running it in somebody's checkout is worse than
    // admitting the tests could not be found: the guess might be a deploy.
    const actor = start({
      ...trusted,
      dynamicReviewer: fromPromise(
        async (): Promise<RanTests> => ({
          ran: false,
          passed: false,
          output: '',
          why: 'this repository declares no test script',
        }),
      ),
    })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.tests?.ran).toBe(false)
    expect(settled.context.tests?.why).toContain('no test script')
    // Still a review, because reading it was the useful part either way.
    expect(settled.context.outcome?.kind).toBe('reviewed')
  })

  test('a checkout that could not be made is a failure, not a silent pass', async () => {
    const actor = start({
      ...trusted,
      dynamicReviewer: fromPromise(async () => {
        throw new Error('could not add the worktree')
      }),
    })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.outcome?.kind).toBe('failed')
  })

  test('failing tests are reported rather than hidden', async () => {
    const actor = start({
      ...trusted,
      dynamicReviewer: fromPromise(
        async (): Promise<RanTests> => ({
          ran: true,
          passed: false,
          output: '(fail) capitalises only the first letter',
        }),
      ),
    })
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 5000,
    })
    expect(settled.context.tests?.passed).toBe(false)
    expect(settled.context.tests?.output).toContain('(fail)')
  })
})
