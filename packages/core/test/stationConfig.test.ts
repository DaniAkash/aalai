import { describe, expect, test } from 'bun:test'
import type { GhIssue } from '@/lib/gh'
import {
  buildAnalystPrompt,
  buildImplementerPrompt,
  stationExtras,
} from '@/prompts/stations'
import type { Analysis } from '@/run/stations/schemas'

const issue: GhIssue = {
  number: 61,
  title: 'formatBytes is off by one',
  body: 'It returns bytes where it should return kilobytes.',
  html_url: 'https://github.com/DaniAkash/aalai-demo/issues/61',
  state: 'open',
  created_at: '2026-10-09T09:00:00Z',
  updated_at: '2026-10-09T09:00:00Z',
  author_association: 'OWNER',
  user: { login: 'someone' },
  labels: [],
}

const analysis = {
  problem_statement: 'The loop never divides.',
  approach: 'Divide while at or above the unit size.',
  plan: ['Correct the comparison'],
  affected_surface: ['src/bytes.ts'],
  risks: [],
  acceptance_criteria: ['formatBytes(1024) returns "1 KB"'],
  test_strategy: 'Unit tests on the boundary.',
} as Analysis

describe('stationExtras', () => {
  test('a station nobody configured adds nothing', () => {
    // The default for every station, so this is the shape most runs see.
    expect(stationExtras({ skills: [], instructions: '' })).toBe('')
    expect(stationExtras(undefined)).toBe('')
  })

  test('skills are named, and said to belong to this station alone', () => {
    const extras = stationExtras({ skills: ['gh-cli'], instructions: '' })
    expect(extras).toContain('gh-cli')
    expect(extras).toContain('not to the others')
  })

  test('instructions that are only whitespace are not instructions', () => {
    // Otherwise clearing the field leaves a blank paragraph in the prompt.
    expect(stationExtras({ skills: [], instructions: '   \n ' })).toBe('')
  })
})

describe('a skill belongs to one station', () => {
  test('a skill given to the analyst does not reach the implementer', () => {
    // The acceptance criterion for per station configuration, checked against
    // what each station is actually handed rather than against the form that
    // sets it.
    const analystPrompt = buildAnalystPrompt({
      repo: 'DaniAkash/aalai-demo',
      issue,
      conventionFiles: [],
      tools: false,
      station: { skills: ['repo-conventions'], instructions: '' },
    })
    const implementerPrompt = buildImplementerPrompt({
      repo: 'DaniAkash/aalai-demo',
      issue,
      analysis,
      conventionFiles: [],
      station: { skills: ['commit-style'], instructions: '' },
    })

    expect(analystPrompt).toContain('repo-conventions')
    expect(analystPrompt).not.toContain('commit-style')
    expect(implementerPrompt).toContain('commit-style')
    expect(implementerPrompt).not.toContain('repo-conventions')
  })

  test('one station being configured leaves the others untouched', () => {
    const configured = buildAnalystPrompt({
      repo: 'DaniAkash/aalai-demo',
      issue,
      conventionFiles: [],
      tools: false,
      station: {
        skills: ['gh-cli'],
        instructions: 'Say what you are unsure of.',
      },
    })
    const bare = buildImplementerPrompt({
      repo: 'DaniAkash/aalai-demo',
      issue,
      analysis,
      conventionFiles: [],
      station: { skills: [], instructions: '' },
    })

    expect(configured).toContain('Say what you are unsure of.')
    expect(bare).not.toContain('Say what you are unsure of.')
    expect(bare).not.toContain('Skills available to you')
  })

  test('instructions come after the conventions, so a repository still wins', () => {
    const prompt = buildAnalystPrompt({
      repo: 'DaniAkash/aalai-demo',
      issue,
      conventionFiles: ['AGENTS.md'],
      tools: false,
      station: { skills: [], instructions: 'Prefer small diffs.' },
    })
    expect(prompt.indexOf('AGENTS.md')).toBeLessThan(
      prompt.indexOf('Prefer small diffs.'),
    )
  })
})
