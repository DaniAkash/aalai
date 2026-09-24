import { describe, expect, test } from 'bun:test'
import { createActor, fromCallback, fromPromise, waitFor } from 'xstate'
import type { CommitOutcome } from '@/run/commit'
import { issueWorkMachine } from '@/run/machines/issueWork'
import { workState } from '@/run/machines/types'
import type { Analysis, Review } from '@/run/stations/schemas'

/**
 * The premise region, driven with a watcher the test controls.
 *
 * Every station has a reason for existing and that reason can stop being true
 * while it works. These assert what the machine does when it does, rather than
 * that a timer was scheduled.
 */

const analysis: Analysis = {
  problem_statement: 'p',
  approach: 'a',
  plan: ['one'],
  affected_surface: [],
  risks: [],
  acceptance_criteria: ['it works'],
  test_strategy: 't',
}

const approval: Review = {
  verdict: 'approve',
  criteria_results: [
    { criterion: 'it works', pass: true, evidence: 'checked' },
  ],
  blocking_findings: [],
  summary: 'fine',
}

/** Raises one premise event, once, as soon as the machine starts watching. */
function raising(event: { type: string; reason: string } | undefined) {
  const trace: string[] = []
  const machine = issueWorkMachine.provide({
    actors: {
      premise: fromCallback(({ sendBack }) => {
        if (event !== undefined) {
          queueMicrotask(() => sendBack(event))
        }
        return () => {}
      }),
      analyst: fromPromise(async () => {
        trace.push('analyst')
        return analysis
      }),
      implementer: fromPromise(
        async (): Promise<{ report: string; commit: CommitOutcome }> => {
          trace.push('implementer')
          await new Promise((resolve) => setTimeout(resolve, 20))
          return { report: 'r', commit: 'committed' }
        },
      ),
      reviewer: fromPromise(async () => {
        trace.push('reviewer')
        return { review: approval }
      }),
    },
  })
  return { machine, trace }
}

async function settle(event?: { type: string; reason: string }) {
  const { machine, trace } = raising(event)
  const actor = createActor(machine, {
    input: {
      runId: 'acme/widgets#7@1',
      repo: 'acme/widgets',
      issueNumber: 7,
      maxRevisions: 2,
      premiseBody: 'the issue text',
    },
  })
  actor.start()
  const settled = await waitFor(actor, (s) => s.status === 'done')
  return { state: workState(settled.value), context: settled.context, trace }
}

describe('the premise region', () => {
  test('a run whose premise holds is untouched by it', async () => {
    const { state, trace } = await settle()
    expect(state).toBe('approved')
    expect(trace).toEqual(['analyst', 'implementer', 'reviewer'])
  })

  test('an issue closed mid run stops the work and says why', async () => {
    const { state, context } = await settle({
      type: 'PREMISE_ABORT',
      reason: 'the issue was closed while the run was working',
    })

    expect(state).toBe('finished')
    expect(context.outcome).toEqual({
      kind: 'stopped',
      reason: 'the issue was closed while the run was working',
    })
  })

  test('an abort stops before the work reaches a verdict', async () => {
    const { trace } = await settle({
      type: 'PREMISE_ABORT',
      reason: 'the issue was closed while the run was working',
    })
    // The plan was already made when the issue closed, but nothing is graded
    // against a request that no longer exists.
    expect(trace).not.toContain('reviewer')
  })

  test('an issue rewritten mid run is replanned rather than abandoned', async () => {
    const { state, context, trace } = await settle({
      type: 'PREMISE_REPLAN',
      reason: 'the issue was rewritten while the run was working',
    })

    // Back to the analyst, because the plan was made against text that no
    // longer exists. The run still finishes rather than being thrown away.
    expect(trace.filter((c) => c === 'analyst').length).toBeGreaterThan(1)
    // A new plan, not another revision of the old one: the generation moves,
    // and the implementation cycle starts over rather than carrying the
    // revisions that were spent on a different request. The review is set
    // again by the end, because the replanned run went on to be approved.
    expect(context.planGeneration).toBeGreaterThan(0)
    expect(context.revision).toBe(0)
    expect(state).toBe('approved')
  })

  test('an abort cancels work still in flight rather than letting it finish', async () => {
    // A promise cannot be un-awaited, so the station is told to stop through a
    // signal. Without it an aborted run spends another few minutes of agent
    // time and commits work nobody will use.
    let cancelled = false
    const machine = issueWorkMachine.provide({
      actors: {
        premise: fromCallback(({ sendBack }) => {
          // Late enough that the implementer is already working, which is the
          // only case where there is anything in flight to cancel.
          const timer = setTimeout(
            () =>
              sendBack({
                type: 'PREMISE_ABORT',
                reason: 'the issue was closed',
              }),
            30,
          )
          return () => clearTimeout(timer)
        }),
        analyst: fromPromise(async () => analysis),
        implementer: fromPromise(
          async ({
            signal,
          }): Promise<{ report: string; commit: CommitOutcome }> => {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 500)
              signal?.addEventListener('abort', () => {
                clearTimeout(timer)
                cancelled = true
                reject(new Error('aborted'))
              })
            })
            return { report: 'r', commit: 'committed' }
          },
        ),
        reviewer: fromPromise(async () => ({ review: approval })),
      },
    })

    const actor = createActor(machine, {
      input: {
        runId: 'acme/widgets#7@1',
        repo: 'acme/widgets',
        issueNumber: 7,
        maxRevisions: 2,
        premiseBody: 'the issue text',
      },
    })
    actor.start()
    await waitFor(actor, (s) => s.status === 'done')

    expect(cancelled).toBe(true)
  })

  test('a replan drops the verdict that was about the old request', async () => {
    // Observed at the moment of the replan rather than at the end, because a
    // run that goes on to be approved has a verdict again by then. Carrying
    // the old one forward would hand the implementer revision guidance about
    // an issue that no longer says that.
    const seen: (string | undefined)[] = []
    const machine = issueWorkMachine.provide({
      actors: {
        premise: fromCallback(({ sendBack }) => {
          const timer = setTimeout(
            () =>
              sendBack({
                type: 'PREMISE_REPLAN',
                reason: 'rewritten',
                body: 'the new issue text',
              }),
            25,
          )
          return () => clearTimeout(timer)
        }),
        analyst: fromPromise(async () => analysis),
        implementer: fromPromise(
          async (): Promise<{ report: string; commit: CommitOutcome }> => {
            // Long enough that the replan lands while it is working, which is
            // the case the assertion is about.
            await new Promise((resolve) => setTimeout(resolve, 60))
            return { report: 'r', commit: 'committed' }
          },
        ),
        reviewer: fromPromise(async () => ({ review: approval })),
      },
    })

    const actor = createActor(machine, {
      input: {
        runId: 'acme/widgets#7@1',
        repo: 'acme/widgets',
        issueNumber: 7,
        maxRevisions: 1,
        premiseBody: 'the issue text',
      },
    })
    actor.subscribe((snap) => {
      if (workState(snap.value) === 'planning') {
        seen.push(snap.context.review?.verdict)
      }
    })
    actor.start()
    const settled = await waitFor(actor, (s) => s.status === 'done')

    // Planning was entered twice: once at the start, once on the replan. The
    // second time carries no verdict, and the rewritten body is the premise.
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.at(-1)).toBeUndefined()
    expect(settled.context.premiseBody).toBe('the new issue text')
  })

  test('the machine only finishes when both regions do', async () => {
    // A parallel machine is done when every region is final, so a premise that
    // never settled would leave a finished run looking like a running one.
    const { state } = await settle()
    expect(state).toBe('approved')
  })
})
