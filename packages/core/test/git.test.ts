import { describe, expect, test } from 'bun:test'
import {
  assertSafeBranch,
  issueBranchName,
  partitionStagePaths,
  porcelainPath,
  UnsafeBranchError,
} from '@/lib/git'

describe('issueBranchName', () => {
  test('slugifies an ordinary title', () => {
    expect(issueBranchName(12, 'Password reset email arrives twice')).toBe(
      'aalai/issue-12-password-reset-email-arrives-twice',
    )
  })

  test('never leaves a trailing separator when the cap lands on one', () => {
    const branch = issueBranchName(3, `${'a'.repeat(38)} bbbb cccc`)
    expect(branch.endsWith('-')).toBe(false)
  })

  test('survives a title made entirely of punctuation', () => {
    expect(issueBranchName(4, '!!! ???')).toBe('aalai/issue-4')
  })

  test('strips characters that would escape the git command line', () => {
    const branch = issueBranchName(5, 'fix; rm -rf / && echo $(whoami)')
    expect(branch).not.toContain(';')
    expect(branch).not.toContain('$')
    expect(branch).not.toContain('&')
    expect(() => assertSafeBranch(branch)).not.toThrow()
  })
})

describe('assertSafeBranch', () => {
  test('refuses the protected branches', () => {
    for (const branch of ['main', 'master', 'HEAD']) {
      expect(() => assertSafeBranch(branch)).toThrow(UnsafeBranchError)
    }
  })

  test('refuses a refs/ prefix that would reach a protected branch by another name', () => {
    expect(() => assertSafeBranch('refs/heads/main')).toThrow(UnsafeBranchError)
  })

  test('refuses traversal and empty segments', () => {
    expect(() => assertSafeBranch('aalai/../main')).toThrow(UnsafeBranchError)
    expect(() => assertSafeBranch('aalai//x')).toThrow(UnsafeBranchError)
  })

  test('accepts a normal factory branch', () => {
    expect(() => assertSafeBranch('aalai/issue-12-fix-thing')).not.toThrow()
  })
})

describe('partitionStagePaths', () => {
  test('keeps ordinary source paths', () => {
    const { deliverable, generated } = partitionStagePaths([
      'src/a.ts',
      'test/b.test.ts',
    ])
    expect(deliverable).toHaveLength(2)
    expect(generated).toHaveLength(0)
  })

  test('separates dependency output an agent installed while verifying', () => {
    const { deliverable, generated } = partitionStagePaths([
      'src/a.ts',
      'node_modules/left-pad/index.js',
      'dist/bundle.js',
    ])
    expect(deliverable).toEqual(['src/a.ts'])
    expect(generated).toHaveLength(2)
  })

  test('matches a generated directory at any depth', () => {
    const { generated } = partitionStagePaths([
      'packages/api/node_modules/x/y.js',
    ])
    expect(generated).toHaveLength(1)
  })

  test('does not match a file whose name merely contains a generated directory name', () => {
    const { deliverable } = partitionStagePaths(['src/build-helpers.ts'])
    expect(deliverable).toHaveLength(1)
  })
})

describe('porcelainPath', () => {
  test('strips the two-character status code and its separator', () => {
    expect(porcelainPath('M  src/a.ts')).toBe('src/a.ts')
    expect(porcelainPath('?? dist/bundle.js')).toBe('dist/bundle.js')
  })

  test('keeps the leading space of an unstaged modification out of the path', () => {
    expect(porcelainPath(' M src/a.ts')).toBe('src/a.ts')
  })

  test('takes the new path of a rename', () => {
    expect(porcelainPath('R  src/old.ts -> src/new.ts')).toBe('src/new.ts')
  })
})
