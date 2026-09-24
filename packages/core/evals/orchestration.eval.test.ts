import { describe, expect, test } from 'bun:test'
import { type CommitOutcome, type LoopDeps, runReviewLoop } from '@/run/loop'
import type { Analysis, Review } from '@/run/stations/schemas'

/**
 * These drive the real loop with recording fakes.
 *
 * The point is that the assertions are about code that ships. A test that
 * hand-writes the expected call order and checks a helper against it asserts
 * nothing about the orchestration; this runs `runReviewLoop` itself and reads
 * back what it actually did.
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

/** Records the order the loop calls its dependencies in. */
function recorder(reviews: Review[], commit: CommitOutcome = 'committed') {
  const trace: string[] = []
  let reviewIndex = 0
  const deps: LoopDeps = {
    implement: async (revision) => {
      trace.push(
        revision === undefined
          ? 'implement'
          : `implement:revision${revision.attempt}`,
      )
      return 'report'
    },
    commit: async (attempt) => {
      trace.push(`commit:${attempt}`)
      return commit
    },
    review: async () => {
      trace.push('review')
      const next = reviews[Math.min(reviewIndex, reviews.length - 1)]
      reviewIndex += 1
      return next ?? review()
    },
  }
  return { deps, trace }
}

describe('the stations run in order, on the real loop', () => {
  test('implement, then commit, then review', async () => {
    const { deps, trace } = recorder([review()])
    const outcome = await runReviewLoop(deps, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('approved')
    expect(trace).toEqual(['implement', 'commit:0', 'review'])
  })

  test('review never runs before the work is committed', async () => {
    const { deps, trace } = recorder([review()])
    await runReviewLoop(deps, analysis, { maxRevisions: 2 })
    expect(trace.indexOf('commit:0')).toBeLessThan(trace.indexOf('review'))
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
    const { deps } = recorder([failed])
    const outcome = await runReviewLoop(deps, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
    expect(outcome.kind === 'stopped' && outcome.reason).toContain(
      'did not pass',
    )
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
    const { deps } = recorder([partial])
    const outcome = await runReviewLoop(deps, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
    expect(outcome.kind === 'stopped' && outcome.reason).toContain('unjudged')
  })

  test('approve that judged criteria nobody wrote is refused', async () => {
    const invented = review({
      criteria_results: [
        { criterion: 'it feels good', pass: true, evidence: 'vibes' },
      ],
    })
    const { deps } = recorder([invented])
    const outcome = await runReviewLoop(deps, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
  })
})

describe('the revision loop is bounded', () => {
  test('changes requested then approved ships, carrying the revision through', async () => {
    const { deps, trace } = recorder([
      review({ verdict: 'request_changes', blocking_findings: ['fix it'] }),
      review(),
    ])
    const outcome = await runReviewLoop(deps, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('approved')
    expect(trace).toEqual([
      'implement',
      'commit:0',
      'review',
      'implement:revision1',
      'commit:1',
      'review',
    ])
  })

  test('it gives up after maxRevisions rather than looping', async () => {
    const { deps, trace } = recorder([review({ verdict: 'request_changes' })])
    const outcome = await runReviewLoop(deps, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
    expect(trace.filter((entry) => entry === 'review')).toHaveLength(3)
  })

  test('maxRevisions of zero means one attempt and no more', async () => {
    const { deps, trace } = recorder([review({ verdict: 'request_changes' })])
    await runReviewLoop(deps, analysis, { maxRevisions: 0 })
    expect(trace).toEqual(['implement', 'commit:0', 'review'])
  })

  test('a rejection stops immediately instead of using its revisions', async () => {
    const { deps, trace } = recorder([
      review({ verdict: 'reject', summary: 'wrong approach' }),
    ])
    const outcome = await runReviewLoop(deps, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
    expect(trace.filter((entry) => entry === 'review')).toHaveLength(1)
  })
})

describe('an empty run never reaches the reviewer', () => {
  test('no file changes stops before review', async () => {
    const { deps, trace } = recorder([review()], 'no-changes')
    const outcome = await runReviewLoop(deps, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
    expect(trace).not.toContain('review')
  })

  test('generated output only stops before review', async () => {
    const { deps, trace } = recorder([review()], 'generated-only')
    const outcome = await runReviewLoop(deps, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
    expect(trace).not.toContain('review')
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
    const { deps } = recorder([numbered])
    const outcome = await runReviewLoop(deps, analysis, { maxRevisions: 2 })
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
    const { deps } = recorder([failed])
    const outcome = await runReviewLoop(deps, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
  })

  test('fewer results than criteria is still refused', async () => {
    const short = review({
      criteria_results: [
        { criterion: 'something else entirely', pass: true, evidence: 'x' },
      ],
    })
    const { deps } = recorder([short])
    const outcome = await runReviewLoop(deps, analysis, { maxRevisions: 2 })
    expect(outcome.kind).toBe('stopped')
  })
})
