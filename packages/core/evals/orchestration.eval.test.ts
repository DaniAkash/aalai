import { describe, expect, test } from 'bun:test'
import { createActor, fromPromise, waitFor } from 'xstate'
import type { CommitOutcome } from '@/run/commit'
import { issueWorkMachine } from '@/run/machines/issueWork'
import { workState } from '@/run/machines/types'
import type { Analysis, Review } from '@/run/stations/schemas'

/**
 * These drive the real machine with recording fakes.
 *
 * The point is that the assertions are about code that ships. A test that
 * hand-writes the expected call order and checks a helper against it asserts
 * nothing about the orchestration; this starts `issueWorkMachine` itself and
 * reads back what it actually did.
 */
const analysis: Analysis = {
  problem_statement: 'p',
  approach: 'a',
  plan: ['s'],
  affected_surface: ['src/a.ts'],
  risks: [],
  acceptance_criteria: [
    'the slug has no trailing hyphen',
    'the signature is unchanged',
  ],
  test_strategy: 'bun test',
}

function review(overrides: Partial<Review> = {}): Review {
  return {
    verdict: 'approve',
    criteria_results: analysis.acceptance_criteria.map((criterion) => ({
      criterion,
      pass: true,
      evidence: 'checked',
    })),
    blocking_findings: [],
    summary: 'fine',
    ...overrides,
  }
}

/** Records the order the machine drives its stations in. */
function recorder(reviews: Review[], commit: CommitOutcome = 'committed') {
  const trace: string[] = []
  let reviewIndex = 0
  const machine = issueWorkMachine.provide({
    actors: {
      analyst: fromPromise(async () => {
        trace.push('analyst')
        return analysis
      }),
      implementer: fromPromise(
        async ({
          input,
        }: {
          input: { runId: string; revision: number; review?: Review }
        }) => {
          trace.push(
            input.revision === 0
              ? 'implement'
              : `implement:revision${input.revision}`,
          )
          // The machine commits inside the same attempt as the turn, so that
          // a restart cannot separate the two.
          trace.push(`commit:${input.revision}`)
          return { report: 'report', commit }
        },
      ),
      reviewer: fromPromise(async () => {
        trace.push('review')
        const next = reviews[Math.min(reviewIndex, reviews.length - 1)]
        reviewIndex += 1
        return { review: next ?? review() }
      }),
    },
  })
  return { machine, trace }
}

/** Runs one issue to a final state and reports what the machine decided. */
async function runReviewLoop(
  built: ReturnType<typeof recorder>,
  _analysis: Analysis,
  config: { maxRevisions: number },
): Promise<{ kind: 'approved' | 'stopped' | 'failed'; reason?: string }> {
  const actor = createActor(built.machine, {
    input: {
      runId: 'acme/widgets#1@1',
      repo: 'acme/widgets',
      issueNumber: 1,
      maxRevisions: config.maxRevisions,
      premiseBody: 'the issue text',
    },
  })
  actor.start()
  const settled = await waitFor(actor, (s) => s.status === 'done')
  if (workState(settled.value) === 'approved') {
    return { kind: 'approved' }
  }
  const outcome = settled.context.outcome
  return outcome === undefined
    ? { kind: 'stopped', reason: 'no outcome' }
    : outcome.kind === 'failed'
      ? { kind: 'failed', reason: outcome.error }
      : { kind: 'stopped', reason: outcome.reason }
}

describe('the stations run in order, on the real loop', () => {
  test('implement, then commit, then review', async () => {
    const built = recorder([review()])
    const outcome = await runReviewLoop(built, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('approved')
    // The machine plans as part of the same unit, so the analyst leads.
    expect(built.trace).toEqual(['analyst', 'implement', 'commit:0', 'review'])
  })

  test('review never runs before the work is committed', async () => {
    const built = recorder([review()])
    await runReviewLoop(built, analysis, { maxRevisions: 2 })
    expect(built.trace.indexOf('commit:0')).toBeLessThan(
      built.trace.indexOf('review'),
    )
  })
})

describe('an approve that does not clear the gate never ships', () => {
  test('approve with a failed criterion is refused', async () => {
    const failed = review({
      criteria_results: [
        {
          criterion: analysis.acceptance_criteria[0] ?? '',
          pass: true,
          evidence: 'ok',
        },
        {
          criterion: analysis.acceptance_criteria[1] ?? '',
          pass: false,
          evidence: 'still broken',
        },
      ],
    })
    const built = recorder([failed])
    const outcome = await runReviewLoop(built, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
    expect(outcome.reason).toContain('did not pass')
  })

  test('approve that judged only some of the criteria is refused', async () => {
    const partial = review({
      criteria_results: [
        {
          criterion: analysis.acceptance_criteria[0] ?? '',
          pass: true,
          evidence: 'ok',
        },
      ],
    })
    const built = recorder([partial])
    const outcome = await runReviewLoop(built, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
    expect(outcome.reason).toContain('unjudged')
  })

  test('approve that judged criteria nobody wrote is refused', async () => {
    const invented = review({
      criteria_results: [
        { criterion: 'it feels good', pass: true, evidence: 'vibes' },
      ],
    })
    const built = recorder([invented])
    const outcome = await runReviewLoop(built, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
  })
})

describe('the revision loop is bounded', () => {
  test('changes requested then approved ships, carrying the revision through', async () => {
    const built = recorder([
      review({ verdict: 'request_changes', blocking_findings: ['fix it'] }),
      review(),
    ])
    const outcome = await runReviewLoop(built, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('approved')
    expect(built.trace).toEqual([
      'analyst',
      'implement',
      'commit:0',
      'review',
      'implement:revision1',
      'commit:1',
      'review',
    ])
    // A revision re-enters the implementer. It is not a replan.
    expect(built.trace.filter((e) => e === 'analyst')).toHaveLength(1)
  })

  test('it gives up after maxRevisions rather than looping', async () => {
    const built = recorder([review({ verdict: 'request_changes' })])
    const outcome = await runReviewLoop(built, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
    expect(built.trace.filter((entry) => entry === 'review')).toHaveLength(3)
  })

  test('maxRevisions of zero means one attempt and no more', async () => {
    const built = recorder([review({ verdict: 'request_changes' })])
    await runReviewLoop(built, analysis, { maxRevisions: 0 })
    // The machine plans as part of the same unit, so the analyst leads.
    expect(built.trace).toEqual(['analyst', 'implement', 'commit:0', 'review'])
  })

  test('a rejection stops immediately instead of using its revisions', async () => {
    const built = recorder([
      review({ verdict: 'reject', summary: 'wrong approach' }),
    ])
    const outcome = await runReviewLoop(built, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
    expect(built.trace.filter((entry) => entry === 'review')).toHaveLength(1)
  })
})

describe('an empty run never reaches the reviewer', () => {
  test('no file changes stops before review', async () => {
    const built = recorder([review()], 'no-changes')
    const outcome = await runReviewLoop(built, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
    expect(built.trace).not.toContain('review')
  })

  test('generated output only stops before review', async () => {
    const built = recorder([review()], 'generated-only')
    const outcome = await runReviewLoop(built, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
    expect(built.trace).not.toContain('review')
  })
})

describe('the gate reconciles how a reviewer echoes a criterion', () => {
  test('a leading list marker does not fail the match', async () => {
    const numbered = review({
      criteria_results: analysis.acceptance_criteria.map((criterion, i) => ({
        // Criteria are numbered when shown to the reviewer, and agents echo
        // that numbering back. A real run was refused over exactly this.
        criterion: `${i + 1}. ${criterion}`,
        pass: true,
        evidence: 'checked',
      })),
    })
    const built = recorder([numbered])
    const outcome = await runReviewLoop(built, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('approved')
  })

  test('a failed criterion is still refused however it is worded', async () => {
    const failed = review({
      criteria_results: analysis.acceptance_criteria.map((criterion, i) => ({
        criterion: `${i + 1}. ${criterion}`,
        pass: i === 0,
        evidence: 'checked',
      })),
    })
    const built = recorder([failed])
    const outcome = await runReviewLoop(built, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
  })

  test('fewer results than criteria is still refused', async () => {
    const short = review({
      criteria_results: [
        { criterion: 'something else entirely', pass: true, evidence: 'x' },
      ],
    })
    const built = recorder([short])
    const outcome = await runReviewLoop(built, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
  })
})
