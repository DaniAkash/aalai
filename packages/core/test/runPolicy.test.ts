import { describe, expect, test } from 'bun:test'
import type { Config } from '@/config'
import { buildAnalystPrompt } from '@/prompts/stations'
import {
  asksFirst,
  planIsGated,
  policyForRepo,
  policyForRun,
} from '@/run/policy'

const config = {
  defaultPolicy: 'automatic',
  watch: [{ repo: 'DaniAkash/aalai', policy: 'plan_gate' }],
} as Config

describe('policyForRun', () => {
  test('what a person chose for this run outranks the repository', () => {
    expect(policyForRun(config, 'DaniAkash/aalai', 'triage')).toBe('triage')
  })

  test('no choice falls back to the repository', () => {
    expect(policyForRun(config, 'DaniAkash/aalai', null)).toBe('plan_gate')
  })

  test('undefined is the same as no choice, not a missing answer', () => {
    // Every run that predates the composer reads as undefined here, and every
    // run the watcher starts has no choice to make.
    expect(policyForRun(config, 'DaniAkash/aalai', undefined)).toBe('plan_gate')
    expect(policyForRun(config, 'other/repo', undefined)).toBe('automatic')
  })

  test('an unwatched repository still gets the global default', () => {
    expect(policyForRepo(config, 'other/repo')).toBe('automatic')
  })
})

describe('the four composer modes', () => {
  test('talking it through still gates the plan', () => {
    // It is the same gate as planning first. Only what the analyst writes
    // before reaching it differs.
    expect(planIsGated('talk')).toBe(true)
    expect(planIsGated('plan_gate')).toBe(true)
  })

  test('starting now and triage do not gate the plan', () => {
    expect(planIsGated('automatic')).toBe(false)
    expect(planIsGated('triage')).toBe(false)
  })

  test('only talking it through asks first', () => {
    expect(asksFirst('talk')).toBe(true)
    for (const other of ['plan_gate', 'automatic', 'triage'] as const) {
      expect(asksFirst(other)).toBe(false)
    }
  })

  test('asking first is a different prompt, not a different label', () => {
    // The whole difference between two of the modes is this text. If it ever
    // stops being added, talking it through silently becomes planning first,
    // which is the kind of mode that looks implemented and is not.
    const base: Parameters<typeof buildAnalystPrompt>[0] = {
      repo: 'DaniAkash/aalai-demo',
      issue: {
        number: 61,
        title: 'formatBytes is off by one',
        body: 'It returns bytes for a kilobyte.',
        html_url: 'https://github.com/DaniAkash/aalai-demo/issues/61',
        state: 'open',
        created_at: '2026-10-09T09:00:00Z',
        updated_at: '2026-10-09T09:00:00Z',
        author_association: 'OWNER',
        user: { login: 'someone' },
        labels: [],
      },
      conventionFiles: [],
      tools: false,
    }

    const planning = buildAnalystPrompt(base)
    const talking = buildAnalystPrompt({ ...base, asksFirst: true })

    expect(talking).toContain('Lead with what you do not know')
    expect(planning).not.toContain('Lead with what you do not know')
    expect(talking.length).toBeGreaterThan(planning.length)
  })
})
