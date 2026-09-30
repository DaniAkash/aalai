import { describe, expect, test } from 'bun:test'
import {
  type Authorship,
  authorsToResolve,
  mayExecute,
} from '@/run/executionTrust'

/**
 * Whether somebody else's code may run on this machine.
 *
 * The expensive mistake is one-directional: refusing to run trusted code costs
 * a person one click, and running untrusted code costs whatever that code
 * decides to do. Every test here is written from that asymmetry.
 */

const mine: Authorship = {
  sha: 'a1',
  authorLogin: 'the-maintainer',
  authorName: 'The Maintainer',
  verified: true,
}

const theirs: Authorship = {
  sha: 'b2',
  authorLogin: null,
  authorName: 'Alex Contributor',
  verified: false,
}

const trusted = new Map([['the-maintainer', 'admin']])

describe('code the repository wrote', () => {
  test('may run', () => {
    expect(
      mayExecute({ commits: [mine], isFork: false, permissions: trusted }),
    ).toEqual({ allowed: true })
  })

  test('and so may several commits of it', () => {
    expect(
      mayExecute({
        commits: [mine, { ...mine, sha: 'a2' }],
        isFork: false,
        permissions: trusted,
      }).allowed,
    ).toBe(true)
  })
})

describe('code somebody else wrote', () => {
  test('may not', () => {
    const verdict = mayExecute({
      commits: [theirs],
      isFork: false,
      permissions: trusted,
    })
    expect(verdict.allowed).toBe(false)
  })

  test('and says whose, so the gate can name them', () => {
    const verdict = mayExecute({
      commits: [theirs],
      isFork: false,
      permissions: trusted,
    })
    expect(verdict.allowed === false && verdict.reason).toContain(
      'Alex Contributor',
    )
  })

  test('one unknown commit among trusted ones is still a no', () => {
    // Running the suite runs all of it. Nineteen commits we wrote do not make
    // the twentieth safe.
    const verdict = mayExecute({
      commits: [mine, { ...mine, sha: 'a2' }, theirs],
      isFork: false,
      permissions: trusted,
    })
    expect(verdict.allowed).toBe(false)
  })

  test('a known login with no write access is a no too', () => {
    // `read` is what GitHub answers for anybody at all on a public repository,
    // so it is not a grant and must not read as one.
    const verdict = mayExecute({
      commits: [
        {
          sha: 'c3',
          authorLogin: 'a-stranger',
          authorName: 'A',
          verified: true,
        },
      ],
      isFork: false,
      permissions: new Map([['a-stranger', 'read']]),
    })
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed === false && verdict.reason).toContain('a-stranger')
  })

  test('a login nobody looked up is not assumed trusted', () => {
    const verdict = mayExecute({
      commits: [
        { sha: 'c3', authorLogin: 'unlooked', authorName: 'U', verified: true },
      ],
      isFork: false,
      permissions: new Map(),
    })
    expect(verdict.allowed).toBe(false)
  })
})

describe('the cases where nothing is known', () => {
  test('a head whose commits could not be read is refused', () => {
    // Not "nothing to worry about". Nothing was looked at.
    expect(
      mayExecute({ commits: [], isFork: false, permissions: trusted }).allowed,
    ).toBe(false)
  })

  test('a fork is refused even when we wrote every commit', () => {
    // It can move between the read and the checkout, so authorship on one does
    // not license running it unattended.
    expect(
      mayExecute({ commits: [mine], isFork: true, permissions: trusted })
        .allowed,
    ).toBe(false)
  })
})

describe('who has to be looked up', () => {
  test('each login once', () => {
    expect(authorsToResolve([mine, { ...mine, sha: 'a2' }, theirs])).toEqual([
      'the-maintainer',
    ])
  })

  test('and an unresolvable author is nobody to look up', () => {
    expect(authorsToResolve([theirs])).toEqual([])
  })
})

describe('a login is a claim rather than a proof', () => {
  test('an unsigned commit is asked about however trusted the account looks', () => {
    // Anybody can set `git config user.email` to a trusted account's public
    // address and GitHub resolves the commit to that account. That is enough to
    // attribute it and nowhere near enough to run it.
    const spoofed: Authorship = {
      sha: 'd4',
      authorLogin: 'the-maintainer',
      authorName: 'The Maintainer',
      verified: false,
    }
    const verdict = mayExecute({
      commits: [spoofed],
      isFork: false,
      permissions: trusted,
    })
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed === false && verdict.reason).toContain('signed')
  })

  test('one unsigned commit among signed ones is still a no', () => {
    const verdict = mayExecute({
      commits: [mine, { ...mine, sha: 'a2', verified: false }],
      isFork: false,
      permissions: trusted,
    })
    expect(verdict.allowed).toBe(false)
  })

  test('and a signed commit from an account with no access is still a no', () => {
    // The two questions are separate: whether we know who wrote it, and whether
    // we trust them. A signature answers only the first.
    const verdict = mayExecute({
      commits: [
        {
          sha: 'e5',
          authorLogin: 'a-stranger',
          authorName: 'A',
          verified: true,
        },
      ],
      isFork: false,
      permissions: new Map([['a-stranger', 'read']]),
    })
    expect(verdict.allowed).toBe(false)
  })
})
