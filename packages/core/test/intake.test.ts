import { describe, expect, test } from 'bun:test'
import type { Config } from '@/config'
import type { GhIssue } from '@/lib/gh'
import { intakePolicyFor, screenIssue } from '@/watch/intake'

function issue(overrides: Partial<GhIssue> = {}): GhIssue {
  return {
    number: 7,
    title: 'Password reset email arrives twice',
    body: 'Throttle the network and submit the form.',
    html_url: 'https://github.com/acme/widgets/issues/7',
    state: 'open',
    created_at: '2026-09-17T10:00:00Z',
    updated_at: '2026-09-17T10:00:00Z',
    author_association: 'OWNER',
    user: { login: 'DaniAkash' },
    labels: [],
    ...overrides,
  }
}

const OPEN_POLICY = { trustedAuthorsOnly: false, requireLabel: null }
const TRUSTED_POLICY = { trustedAuthorsOnly: true, requireLabel: null }

describe('screenIssue', () => {
  test('accepts a plain open issue from the owner', () => {
    expect(screenIssue(issue(), TRUSTED_POLICY).accepted).toBe(true)
  })

  test('rejects pull requests, which the REST issues endpoint also returns', () => {
    const screening = screenIssue(
      issue({ pull_request: { url: 'https://…' } }),
      OPEN_POLICY,
    )
    expect(screening.accepted).toBe(false)
    expect(screening).toHaveProperty('reason', 'is a pull request')
  })

  test('rejects closed issues', () => {
    expect(screenIssue(issue({ state: 'closed' }), OPEN_POLICY).accepted).toBe(
      false,
    )
  })

  test('rejects an untrusted author when the trust gate is on', () => {
    const screening = screenIssue(
      issue({ author_association: 'NONE' }),
      TRUSTED_POLICY,
    )
    expect(screening.accepted).toBe(false)
  })

  test('accepts an untrusted author when the trust gate is off', () => {
    expect(
      screenIssue(issue({ author_association: 'NONE' }), OPEN_POLICY).accepted,
    ).toBe(true)
  })

  test('accepts COLLABORATOR and MEMBER as trusted', () => {
    for (const association of ['COLLABORATOR', 'MEMBER']) {
      expect(
        screenIssue(issue({ author_association: association }), TRUSTED_POLICY)
          .accepted,
      ).toBe(true)
    }
  })

  test('honours a required label', () => {
    const policy = { trustedAuthorsOnly: false, requireLabel: 'aalai' }
    expect(screenIssue(issue(), policy).accepted).toBe(false)
    expect(
      screenIssue(issue({ labels: [{ name: 'aalai' }] }), policy).accepted,
    ).toBe(true)
  })
})

describe('intakePolicyFor', () => {
  const config = {
    trustedAuthorsOnly: true,
    requireLabel: 'factory',
  } as Config

  test("a repository's own label overrides the global default", () => {
    const policy = intakePolicyFor(config, {
      repo: 'acme/widgets',
      requireLabel: 'ready',
    })
    expect(policy.requireLabel).toBe('ready')
  })

  test('a repository without one falls back to the global default', () => {
    const policy = intakePolicyFor(config, { repo: 'acme/widgets' })
    expect(policy.requireLabel).toBe('factory')
  })

  test('both absent leaves the gate open', () => {
    const policy = intakePolicyFor(
      { ...config, requireLabel: null } as Config,
      {
        repo: 'acme/widgets',
      },
    )
    expect(policy.requireLabel).toBeNull()
  })

  // The label only matters if screening actually applies it, which is the hop
  // that was missing: the value was read from config rather than the repository.
  test('a per repository label actually gates an issue', () => {
    const policy = intakePolicyFor(config, {
      repo: 'acme/widgets',
      requireLabel: 'ready',
    })
    expect(screenIssue(issue({ labels: [] }), policy).accepted).toBe(false)
    expect(
      screenIssue(issue({ labels: [{ name: 'ready' }] }), policy).accepted,
    ).toBe(true)
  })
})
