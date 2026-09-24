import { describe, expect, test } from 'bun:test'
import { createActor, fromPromise, waitFor } from 'xstate'
import { issueWorkMachine } from '@/run/machines/issueWork'
import type { Analysis, Review } from '@/run/stations/schemas'

/**
 * The machine driven with recording fakes for its stations.
 *
 * The order the stations are called in, and the decisions taken between them,
 * are the thing worth asserting. A test that hand writes the expected order
 * asserts nothing about the code that produces it.
 */

const analysis: Analysis = {
  problem_statement: 'the helper ignores its count',
  approach: 'select the singular for exactly one',
  plan: ['fix the helper'],
  affected_surface: ['src/pluralise.ts'],
  risks: [],
  acceptance_criteria: ['one returns the singular', 'three returns the plural'],
  test_strategy: 'unit tests',
}

function review(overrides: Partial<Review> = {}): Review {
  return {
    verdict: 'approve',
    criteria_results: analysis.acceptance_criteria.map((criterion) => ({
      criterion,
      pass: true,
      evidence: 'asserted in the test',
    })),
    blocking_findings: [],
    summary: 'looks right',
    ...overrides,
  }
}

interface Trace {
  readonly calls: string[]
}

function drive(options: {
  reviews: Review[]
  commit?: 'committed' | 'no-changes' | 'generated-only'
  maxRevisions?: number
}) {
  const trace: Trace = { calls: [] }
  let reviewIndex = 0

  const machine = issueWorkMachine.provide({
    actors: {
      analyst: fromPromise(async () => {
        trace.calls.push('analyst')
        return analysis
      }),
      implementer: fromPromise(async () => {
        trace.calls.push('implementer')
        return {
          report: 'did the work',
          commit: options.commit ?? ('committed' as const),
        }
      }),
      reviewer: fromPromise(async () => {
        trace.calls.push('reviewer')
        const next = options.reviews[reviewIndex] ?? review()
        reviewIndex += 1
        return { review: next }
      }),
    },
  })

  const actor = createActor(machine, {
    input: {
      runId: 'acme/widgets#7@1',
      repo: 'acme/widgets',
      issueNumber: 7,
      maxRevisions: options.maxRevisions ?? 2,
      premiseBody: 'the issue text',
    },
  })
  actor.start()
  return { actor, trace }
}

describe('what a snapshot holds', () => {
  test('it survives being written down and read back', async () => {
    const { actor } = drive({ reviews: [review()] })
    await waitFor(actor, (s) => s.status === 'done')

    // Snapshots are persisted as json on every transition, so anything in
    // context that cannot round trip would be lost on a restore.
    const persisted = actor.getPersistedSnapshot()
    const roundTripped = JSON.parse(JSON.stringify(persisted))
    expect(roundTripped).toEqual(persisted)
  })

  test('it carries the plan and the verdict, which is what a restart needs', async () => {
    const { actor } = drive({ reviews: [review()] })
    const snapshot = await waitFor(actor, (s) => s.status === 'done')
    expect(snapshot.context.analysis?.acceptance_criteria).toHaveLength(2)
    expect(snapshot.context.review?.verdict).toBe('approve')
  })
})
