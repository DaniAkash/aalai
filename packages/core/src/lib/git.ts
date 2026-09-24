import { githubEnv } from '@/lib/credentials'
import { exec, execOrThrow } from '@/lib/proc'

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
  const branch =
    slug === ''
      ? `aalai/issue-${issueNumber}`
      : `aalai/issue-${issueNumber}-${slug}`
  assertSafeBranch(branch)
  return branch
}

export async function defaultBranch(repoDir: string): Promise<string> {
  const ref = await execOrThrow(
    ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    {
      cwd: repoDir,
    },
  )
  return ref.replace(/^origin\//, '')
}

export async function fetchOrigin(repoDir: string): Promise<void> {
  await execOrThrow(['git', 'fetch', '--prune', 'origin'], {
    cwd: repoDir,
    env: githubEnv(),
  })
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

export async function removeWorktree(
  repoDir: string,
  worktreePath: string,
): Promise<void> {
  await exec(['git', 'worktree', 'remove', '--force', worktreePath], {
    cwd: repoDir,
  })
  await exec(['git', 'worktree', 'prune'], { cwd: repoDir })
}

/**
 * Parses one `git status --porcelain` line into its path.
 *
 * The first two characters are the status code and the third is a separator, so
 * the path starts at index three. A rename reports `old -> new`; the new path is
 * the one that matters. Lines are not trimmed before slicing, because an
 * unstaged modification reports a leading space that is part of the status code.
 */
export function porcelainPath(line: string): string {
  const path = line.slice(3)
  const renameArrow = path.indexOf(' -> ')
  return renameArrow === -1 ? path : path.slice(renameArrow + 4)
}

/**
 * Paths the agent changed. An empty array means it changed nothing.
 *
 * `--untracked-files=all` matters: by default git collapses a new directory to
 * the directory itself, so a run that added `src/feature/` would report one
 * entry rather than the files inside it, and both the artifact partition and the
 * pull request's file list would be working from a folder name.
 */
export async function changedFiles(worktree: string): Promise<string[]> {
  const out = await execOrThrow(
    ['git', 'status', '--porcelain', '--untracked-files=all'],
    {
      cwd: worktree,
    },
  )
  return out === ''
    ? []
    : out
        .split('\n')
        .filter((line) => line.length > 3)
        .map(porcelainPath)
}

/**
 * Directory names that are build or dependency output rather than source.
 *
 * An agent verifying its work will often install dependencies or run a build,
 * and `git add -A` would stage whatever that produced. A repository whose
 * ignore rules already cover these is unaffected; one whose rules do not would
 * otherwise ship a pull request containing its own `node_modules`.
 */
const GENERATED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'target',
  '.gradle',
])

/** Splits porcelain status paths into what should ship and what an agent generated. */
export function partitionStagePaths(paths: readonly string[]): {
  readonly deliverable: string[]
  readonly generated: string[]
} {
  const deliverable: string[] = []
  const generated: string[] = []
  for (const path of paths) {
    const segments = path.split('/')
    if (segments.some((segment) => GENERATED_DIRECTORIES.has(segment))) {
      generated.push(path)
    } else {
      deliverable.push(path)
    }
  }
  return { deliverable, generated }
}

/**
 * Stages everything except build and dependency output.
 *
 * The exclusions are pathspecs rather than a post-hoc unstage, so nothing
 * generated is ever briefly in the index.
 */
export async function stageAll(worktree: string): Promise<string[]> {
  const excludes = [...GENERATED_DIRECTORIES].map(
    (dir) => `:(exclude,glob)**/${dir}/**`,
  )
  await execOrThrow(['git', 'add', '-A', '--', '.', ...excludes], {
    cwd: worktree,
  })

  // An exclude pathspec only stops a matching file being added by this command.
  // It does not remove an entry already in the index, and the agent has shell
  // access, so anything it staged itself would otherwise still be committed.
  const staged = await execOrThrow(['git', 'diff', '--cached', '--name-only'], {
    cwd: worktree,
  })
  const { generated } = partitionStagePaths(
    staged === '' ? [] : staged.split('\n').filter((line) => line !== ''),
  )
  if (generated.length > 0) {
    // `git restore --staged` rewrites the index entry from HEAD, which is right
    // when the path is tracked. It needs a HEAD to resolve, so a repository with
    // no commits yet falls back to dropping the entry outright; with no HEAD
    // nothing is tracked, so that is the same outcome.
    const restore = await exec(
      ['git', 'restore', '--staged', '--', ...generated],
      {
        cwd: worktree,
      },
    )
    if (restore.exitCode !== 0) {
      await execOrThrow(
        ['git', 'rm', '--cached', '-q', '--ignore-unmatch', '--', ...generated],
        {
          cwd: worktree,
        },
      )
    }
  }
  return generated
}

/**
 * Commits the staged tree under an explicit identity.
 *
 * Both name and email are passed per-command rather than relying on the
 * machine's global git config, so delivery does not depend on unrelated local
 * configuration: a host with gh auth but no `user.name` would otherwise fail
 * here with "Author identity unknown".
 */
export async function commit(
  worktree: string,
  message: string,
  identity: { readonly name: string; readonly email: string },
): Promise<string> {
  await execOrThrow(
    [
      'git',
      '-c',
      `user.name=${identity.name}`,
      '-c',
      `user.email=${identity.email}`,
      'commit',
      '-m',
      message,
    ],
    { cwd: worktree },
  )
  return execOrThrow(['git', 'rev-parse', 'HEAD'], { cwd: worktree })
}

export async function pushBranch(
  worktree: string,
  branch: string,
): Promise<void> {
  assertSafeBranch(branch)
  await execOrThrow(
    [
      'git',
      'push',
      '--set-upstream',
      'origin',
      `refs/heads/${branch}:refs/heads/${branch}`,
    ],
    { cwd: worktree, env: githubEnv() },
  )
}

export async function diffStat(
  worktree: string,
  base: string,
): Promise<string> {
  return execOrThrow(['git', 'diff', '--stat', `origin/${base}...HEAD`], {
    cwd: worktree,
  })
}

/** Adds a worktree for a branch that already exists, used for the review checkout. */
export async function addExistingBranchWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  assertSafeBranch(branch)
  await execOrThrow(
    ['git', 'worktree', 'add', '--detach', worktreePath, branch],
    { cwd: repoDir },
  )
}

/** Commits whatever is staged without touching the working tree of other worktrees. */
export async function hasStagedChanges(worktree: string): Promise<boolean> {
  const out = await exec(['git', 'diff', '--cached', '--quiet'], {
    cwd: worktree,
  })
  return out.exitCode !== 0
}

/** Files changed on the branch relative to its base, from the committed history. */
export async function diffNames(
  worktree: string,
  base: string,
): Promise<string[]> {
  const out = await execOrThrow(
    ['git', 'diff', '--name-only', `origin/${base}...HEAD`],
    {
      cwd: worktree,
    },
  )
  return out === '' ? [] : out.split('\n').filter((line) => line !== '')
}
