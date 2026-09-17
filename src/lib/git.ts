import { exec, execOrThrow } from '@/lib/proc'

const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(['main', 'master', 'HEAD'])

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
  if (!BRANCH_PATTERN.test(branch) || branch.includes('..') || branch.includes('//')) {
    throw new UnsafeBranchError(branch, 'not a valid branch name')
  }
  if (branch.startsWith('refs/')) {
    throw new UnsafeBranchError(branch, 'pass a plain name without a refs/ prefix')
  }
  if (PROTECTED_BRANCHES.has(branch)) {
    throw new UnsafeBranchError(branch, 'aalai delivers pull requests, never direct pushes')
  }
}

/**
 * Derives a branch name from an issue. The length cap is applied before trimming
 * separators, because slicing a hyphenated slug at a fixed offset regularly lands
 * on a hyphen and would produce a trailing separator.
 */
export function issueBranchName(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
  const branch = slug === '' ? `aalai/issue-${issueNumber}` : `aalai/issue-${issueNumber}-${slug}`
  assertSafeBranch(branch)
  return branch
}

export async function defaultBranch(repoDir: string): Promise<string> {
  const ref = await execOrThrow(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: repoDir,
  })
  return ref.replace(/^origin\//, '')
}

export async function fetchOrigin(repoDir: string): Promise<void> {
  await execOrThrow(['git', 'fetch', '--prune', 'origin'], { cwd: repoDir })
}

export async function addWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string,
  base: string,
): Promise<void> {
  assertSafeBranch(branch)
  await execOrThrow(
    ['git', 'worktree', 'add', '-b', branch, worktreePath, `origin/${base}`],
    { cwd: repoDir },
  )
}

export async function removeWorktree(repoDir: string, worktreePath: string): Promise<void> {
  await exec(['git', 'worktree', 'remove', '--force', worktreePath], { cwd: repoDir })
  await exec(['git', 'worktree', 'prune'], { cwd: repoDir })
}

/** Porcelain status lines. An empty array means the agent changed nothing. */
export async function changedFiles(worktree: string): Promise<string[]> {
  const out = await execOrThrow(['git', 'status', '--porcelain'], { cwd: worktree })
  return out === '' ? [] : out.split('\n').map((line) => line.trim())
}

export async function stageAll(worktree: string): Promise<void> {
  await execOrThrow(['git', 'add', '-A'], { cwd: worktree })
}

export async function commit(worktree: string, message: string, email: string): Promise<string> {
  await execOrThrow(['git', '-c', `user.email=${email}`, 'commit', '-m', message], {
    cwd: worktree,
  })
  return execOrThrow(['git', 'rev-parse', 'HEAD'], { cwd: worktree })
}

export async function pushBranch(worktree: string, branch: string): Promise<void> {
  assertSafeBranch(branch)
  await execOrThrow(
    ['git', 'push', '--set-upstream', 'origin', `refs/heads/${branch}:refs/heads/${branch}`],
    { cwd: worktree },
  )
}

export async function diffStat(worktree: string, base: string): Promise<string> {
  return execOrThrow(['git', 'diff', '--stat', `origin/${base}...HEAD`], { cwd: worktree })
}
