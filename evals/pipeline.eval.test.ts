import { describe, expect, test } from 'bun:test'
import { buildAnalystPrompt, buildImplementerPrompt, buildReviewerPrompt } from '@/prompts/stations'
import { analysisSchema, reviewSchema } from '@/run/stations/schemas'
import { parseStationOutput } from '@/lib/structured'
import { issueFixture } from './harness'

const analysis = {
  problem_statement: 'The slug keeps separators at both ends.',
  approach: 'Trim them after replacement.',
  plan: ['Trim leading and trailing separators'],
  affected_surface: ['src/slugify.ts'],
  risks: ['None material'],
  acceptance_criteria: [
    "slugify('  Hello World!  ') returns 'hello-world'",
    'No leading or trailing hyphen remains for any input',
  ],
  test_strategy: 'bun test test/slugify.test.ts',
}

describe('the acceptance criteria reach the stations that need them', () => {
  test('the implementer is handed the criteria it will be graded against', () => {
    const prompt = buildImplementerPrompt({
      repo: 'acme/widgets',
      issue: issueFixture(),
      analysis,
      conventionFiles: ['AGENTS.md'],
    })
    for (const criterion of analysis.acceptance_criteria) {
      expect(prompt).toContain(criterion)
    }
    expect(prompt).toContain('written before any code existed')
  })

  test('the reviewer is handed the same criteria, verbatim', () => {
    const prompt = buildReviewerPrompt({
      repo: 'acme/widgets',
      issue: issueFixture(),
      analysis,
      base: 'main',
      branch: 'aalai/issue-1',
    })
    for (const criterion of analysis.acceptance_criteria) {
      expect(prompt).toContain(criterion)
    }
  })

  test('the reviewer is pointed at the real diff, not at a summary', () => {
    const prompt = buildReviewerPrompt({
      repo: 'acme/widgets',
      issue: issueFixture(),
      analysis,
      base: 'main',
      branch: 'aalai/issue-1',
    })
    expect(prompt).toContain('git diff main...aalai/issue-1')
    expect(prompt).toContain('Summaries describe intent; diffs describe reality')
  })

  test('the analyst is told not to write code', () => {
    const prompt = buildAnalystPrompt({
      repo: 'acme/widgets',
      issue: issueFixture(),
      conventionFiles: [],
    })
    expect(prompt).toContain('Do not modify anything')
  })

  test('a revision run carries the failed criteria back to the implementer', () => {
    const prompt = buildImplementerPrompt({
      repo: 'acme/widgets',
      issue: issueFixture(),
      analysis,
      conventionFiles: [],
      revision: {
        attempt: 1,
        review: {
          verdict: 'request_changes',
          criteria_results: [
            { criterion: analysis.acceptance_criteria[1] ?? '', pass: false, evidence: 'still trailing' },
          ],
          blocking_findings: ['Trailing hyphen remains for punctuation-only input'],
          summary: 'Close, one case left.',
        },
      },
    })
    expect(prompt).toContain('revision 1')
    expect(prompt).toContain('Trailing hyphen remains')
  })
})

describe('station output is validated against its schema', () => {
  test('a well-formed analysis parses', () => {
    const reply = `Here is the plan.\n\n\`\`\`json\n${JSON.stringify(analysis)}\n\`\`\``
    const parsed = parseStationOutput(reply, analysisSchema)
    expect(parsed.ok).toBe(true)
  })

  test('an analysis with no acceptance criteria is rejected', () => {
    const reply = `\`\`\`json\n${JSON.stringify({ ...analysis, acceptance_criteria: [] })}\n\`\`\``
    const parsed = parseStationOutput(reply, analysisSchema)
    expect(parsed.ok).toBe(false)
  })

  test('a verdict outside the allowed set is rejected', () => {
    const reply = `\`\`\`json\n${JSON.stringify({ verdict: 'lgtm', criteria_results: [{ criterion: 'x', pass: true, evidence: 'y' }], blocking_findings: [], summary: 'ok' })}\n\`\`\``
    expect(parseStationOutput(reply, reviewSchema).ok).toBe(false)
  })

  test('a review with no criterion results at all is rejected', () => {
    const reply = `\`\`\`json\n${JSON.stringify({ verdict: 'approve', criteria_results: [], blocking_findings: [], summary: 'ok' })}\n\`\`\``
    expect(parseStationOutput(reply, reviewSchema).ok).toBe(false)
  })

  test('the last JSON block wins, so a revised reply parses', () => {
    const approved = {
      verdict: 'approve',
      criteria_results: [{ criterion: 'it works', pass: true, evidence: 'the test passes' }],
      blocking_findings: [],
      summary: 'fine',
    }
    const reply = `\`\`\`json\n{"verdict":"reject"}\n\`\`\`\n\nCorrecting that:\n\n\`\`\`json\n${JSON.stringify(approved)}\n\`\`\``
    const parsed = parseStationOutput(reply, reviewSchema)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.value.verdict).toBe('approve')
  })
})

describe('the schema is strict where it matters and forgiving where it does not', () => {
  test('a station that enumerated its test strategy is still accepted', () => {
    const reply = `\`\`\`json\n${JSON.stringify({
      ...analysis,
      test_strategy: ['run the focused test', 'then the full suite'],
    })}\n\`\`\``
    const parsed = parseStationOutput(reply, analysisSchema)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.value.test_strategy).toContain('run the focused test')
  })

  test('but acceptance criteria must still be a list with something in it', () => {
    const reply = `\`\`\`json\n${JSON.stringify({ ...analysis, acceptance_criteria: 'be correct' })}\n\`\`\``
    expect(parseStationOutput(reply, analysisSchema).ok).toBe(false)
  })
})
