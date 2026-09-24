import type { Config } from '@/config'
import type { GhIssue } from '@/lib/gh'
import { screenIssue } from '@/watch/intake'

/**
 * The eval harness.
 *
 * Every case asserts on what the factory *did*: which stations ran, in what
 * order, which tools the agent called, what the gate decided. None of them
 * assert on prose, because prose is the one part of an agent's output that
 * changes for free.
 */
export interface EvalCase {
  readonly name: string
  readonly tags: readonly string[]
  readonly run: () => Promise<void>
}

export class EvalFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvalFailure'
  }
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new EvalFailure(message)
  }
}

/** Asserts that `names` appear in `trace` in this order, ignoring anything else. */
export function calledInOrder(
  trace: readonly string[],
  names: readonly string[],
): boolean {
  let cursor = 0
  for (const entry of trace) {
    if (entry === names[cursor]) {
      cursor += 1
    }
    if (cursor === names.length) {
      return true
    }
  }
  return names.length === 0
}

/** The gate decision for one issue, so a case can assert on it without a network call. */
export function screen(
  issue: GhIssue,
  config: Pick<Config, 'trustedAuthorsOnly' | 'requireLabel'>,
) {
  return screenIssue(issue, {
    trustedAuthorsOnly: config.trustedAuthorsOnly,
    requireLabel: config.requireLabel,
  })
}

export function issueFixture(overrides: Partial<GhIssue> = {}): GhIssue {
  return {
    number: 1,
    title: 'Something is broken',
    body: 'It breaks when I click save.',
    html_url: 'https://github.com/acme/widgets/issues/1',
    state: 'open',
    created_at: '2026-09-18T10:00:00Z',
    updated_at: '2026-09-18T10:00:00Z',
    author_association: 'OWNER',
    user: { login: 'DaniAkash' },
    labels: [],
    ...overrides,
  }
}
