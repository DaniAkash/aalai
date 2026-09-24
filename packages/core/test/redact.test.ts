import { describe, expect, test } from 'bun:test'
import { redactLocalPaths } from '@/lib/redact'

const WORKTREE = '/Users/someone/workbench/worktrees/Acme/widgets/aalai-issue-9'

describe('redactLocalPaths', () => {
  test('rewrites a worktree-absolute citation to a repository path', () => {
    const text = `Implemented it in [src/wordwrap.ts](${WORKTREE}/src/wordwrap.ts:6).`
    expect(redactLocalPaths(text, WORKTREE)).toBe(
      'Implemented it in [src/wordwrap.ts](src/wordwrap.ts:6).',
    )
  })

  test('leaves repository-relative paths alone', () => {
    const text = 'Changed src/wordwrap.ts and test/wordwrap.test.ts.'
    expect(redactLocalPaths(text, WORKTREE)).toBe(text)
  })

  test('strips a home directory path from another checkout', () => {
    const text =
      'Compared against /Users/someone/other/repo/src/a.ts for reference.'
    const out = redactLocalPaths(text, WORKTREE)
    expect(out).not.toContain('/Users/')
    expect(out).toContain('src/a.ts')
  })

  test('never leaves a username-bearing path behind', () => {
    const text = `See ${WORKTREE}/src/x.ts and /home/ci/build/out.log`
    const out = redactLocalPaths(text, WORKTREE)
    expect(out).not.toContain('/Users/')
    expect(out).not.toContain('/home/')
  })
})

describe('URLs survive redaction', () => {
  test('a pull request link is left intact', () => {
    const text =
      'Opened https://github.com/DaniAkash/aalai-demo/pull/14 for this.'
    expect(redactLocalPaths(text, WORKTREE)).toBe(text)
  })

  test('an http link with a deep path is left intact', () => {
    const text = 'See http://example.com/a/b/c/d for the spec.'
    expect(redactLocalPaths(text, WORKTREE)).toBe(text)
  })

  test('a local path next to a URL is still redacted', () => {
    const out = redactLocalPaths(
      `See https://github.com/acme/widgets/pull/3 and ${WORKTREE}/src/a.ts`,
      WORKTREE,
    )
    expect(out).toContain('https://github.com/acme/widgets/pull/3')
    expect(out).not.toContain('/Users/')
    expect(out).toContain('src/a.ts')
  })
})
