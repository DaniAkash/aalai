import { describe, expect, test } from 'bun:test'
import { redactLocalPaths } from '@/lib/redact'

const WORKTREE = '/Users/someone/workbench/worktrees/Acme/widgets/aalai-issue-9'

describe('redactLocalPaths', () => {
  test('rewrites a worktree-absolute citation to a repository path', () => {
    const text = `Implemented it in [src/wordwrap.ts](${WORKTREE}/src/wordwrap.ts:6).`
    expect(redactLocalPaths(text, WORKTREE)).toBe('Implemented it in [src/wordwrap.ts](src/wordwrap.ts:6).')
  })

  test('leaves repository-relative paths alone', () => {
    const text = 'Changed src/wordwrap.ts and test/wordwrap.test.ts.'
    expect(redactLocalPaths(text, WORKTREE)).toBe(text)
  })

  test('strips a home directory path from another checkout', () => {
    const text = 'Compared against /Users/someone/other/repo/src/a.ts for reference.'
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
