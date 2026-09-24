import { describe, expect, test } from 'bun:test'
import { createActor, fromCallback, fromPromise, waitFor } from 'xstate'
import type { CommitOutcome } from '@/run/commit'
import { issueWorkMachine } from '@/run/machines/issueWork'
import { workState } from '@/run/machines/types'
import type { Analysis, Review } from '@/run/stations/schemas'

/**
 * The plan gate, driven through the real machine.
 *
 * The question these answer is not "was a row written" but "does a gated run
 * stop before any code is written, and does the answer decide what happens
 * next", which is the whole point of the feature.
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
  criteria_results: [{ criterion: 'it works', pass: true, evidence: 'ok' }],
  blocking_findings: [],
  summary: 'fine',
}

/** A machine whose gate answers with whatever the test hands it. */
function gated(
  answer: { decision: string; reason?: string } | undefined,
  planGated = true,
) {
  const trace: string[] = []
  const machine = issueWorkMachine.provide({
    actors: {
      premise: fromCallback(() => () => {}),
      gateKeeper: fromCallback(({ sendBack }) => {
        trace.push('gate')
        if (answer !== undefined) {
          queueMicrotask(() =>
            sendBack({
              type: 'GATE_ANSWERED',
              gateId: 'g1',
              decision: answer.decision,
              reason: answer.reason ?? '',
            }),
          )
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
          return { report: 'r', commit: 'committed' }
        },
      ),
      reviewer: fromPromise(async () => {
        trace.push('reviewer')
        return { review: approval }
      }),
    },
  })
  const actor = createActor(machine, {
    input: {
      runId: 'acme/widgets#7@1',
      repo: 'acme/widgets',
      issueNumber: 7,
      maxRevisions: 2,
      premiseBody: 'the issue',
      planGated,
    },
  })
  return { actor, trace }
}

describe('a gated run', () => {
  test('stops after planning and writes no code until answered', async () => {
    const { actor, trace } = gated(undefined)
    actor.start()

    await waitFor(actor, (s) => workState(s.value) === 'gatingPlan', {
      timeout: 2000,
    })

    expect(trace).toEqual(['analyst', 'gate'])
    // The whole point: the implementer has not run.
    expect(trace).not.toContain('implementer')
    actor.stop()
  })

  test('an approval lets the run carry on into the implementer', async () => {
    const { actor, trace } = gated({ decision: 'approved' })
    actor.start()

    const done = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 4000,
    })

    expect(workState(done.value)).toBe('approved')
    expect(trace).toEqual(['analyst', 'gate', 'implementer', 'reviewer'])
  })

  test('asking for changes plans again rather than implementing', async () => {
    const { actor, trace } = gated({
      decision: 'changes',
      reason: 'the criteria miss the error path',
    })
    actor.start()

    // Planning again re-enters the gate, so the run does not settle. What is
    // being asserted is the order it went round in.
    await waitFor(
      actor,
      () => trace.filter((s) => s === 'analyst').length > 1,
      {
        timeout: 4000,
      },
    )

    expect(trace.slice(0, 4)).toEqual(['analyst', 'gate', 'analyst', 'gate'])
    expect(trace).not.toContain('implementer')
    actor.stop()
  })

  test('a rejection stops the run and says why', async () => {
    const { actor, trace } = gated({
      decision: 'rejected',
      reason: 'not worth doing',
    })
    actor.start()

    const done = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 4000,
    })

    expect(workState(done.value)).toBe('finished')
    expect(done.context.outcome).toEqual({
      kind: 'stopped',
      reason: 'not worth doing',
    })
    expect(trace).not.toContain('implementer')
  })

  test('a replan resets the revision count, not just the plan', async () => {
    const { actor } = gated({ decision: 'changes' })
    actor.start()

    await waitFor(actor, (s) => s.context.planGeneration > 0, { timeout: 4000 })

    expect(actor.getSnapshot().context.revision).toBe(0)
    expect(actor.getSnapshot().context.review).toBeUndefined()
    actor.stop()
  })
})

describe('an ungated run', () => {
  test('never enters the gate at all', async () => {
    const { actor, trace } = gated(undefined, false)
    actor.start()

    const done = await waitFor(actor, (s) => s.status === 'done', {
      timeout: 4000,
    })

    expect(workState(done.value)).toBe('approved')
    expect(trace).toEqual(['analyst', 'implementer', 'reviewer'])
    expect(trace).not.toContain('gate')
  })
})
