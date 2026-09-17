import { describe, expect, test } from 'bun:test'
import { assertSafeBranch, issueBranchName, UnsafeBranchError } from '@/lib/git'

describe('issueBranchName', () => {
  test('slugifies an ordinary title', () => {
    expect(issueBranchName(12, 'Password reset email arrives twice')).toBe(
      'aalai/issue-12-password-reset-email-arrives-twice',
    )
  })

  test('never leaves a trailing separator when the cap lands on one', () => {
    const branch = issueBranchName(3, 'a'.repeat(38) + ' bbbb cccc')
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
