/**
 * What counts as a branch name aalai is willing to interpolate.
 *
 * Its own module because both `git` and `gitWorktree` need it, and when it
 * lived in `git` the worktree helpers had to import from the module that
 * re-exports them, which is a cycle. A guard that every git command depends on
 * is the wrong thing to reach for through a cycle.
 */

const PROTECTED_BRANCHES: ReadonlySet<string> = new Set([
  'main',
  'master',
  'HEAD',
])

/**
 * Conservative subset of valid git branch names. Everything interpolated into a
 * git command must match, so a slug derived from an issue title (untrusted text)
 * can never carry shell metacharacters or escape into a ref path.
 */
const BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/

export class UnsafeBranchError extends Error {
  constructor(branch: string, detail: string) {
    super(`Refusing to use branch "${branch}": ${detail}`)
    this.name = 'UnsafeBranchError'
  }
}

/** Throws unless `branch` is a plain, non-protected branch name safe to interpolate. */
export function assertSafeBranch(branch: string): void {
  if (
    !BRANCH_PATTERN.test(branch) ||
    branch.includes('..') ||
    branch.includes('//')
  ) {
    throw new UnsafeBranchError(branch, 'not a valid branch name')
  }
  if (branch.startsWith('refs/')) {
    throw new UnsafeBranchError(
      branch,
      'pass a plain name without a refs/ prefix',
    )
  }
  if (PROTECTED_BRANCHES.has(branch)) {
    throw new UnsafeBranchError(
      branch,
      'aalai delivers pull requests, never direct pushes',
    )
  }
}
