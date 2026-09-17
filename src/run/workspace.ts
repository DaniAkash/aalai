import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { workbenchDir } from '@/config'
import * as git from '@/lib/git'
import { logger } from '@/lib/log'
import { exec, execOrThrow } from '@/lib/proc'

const log = logger('workspace')

export interface Workspace {
  readonly repo: string
  readonly clonePath: string
  readonly worktreePath: string
  readonly branch: string
  readonly base: string
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/')
  if (owner === undefined || name === undefined || owner === '' || name === '') {
    throw new Error(`Expected owner/repo, got "${repo}"`)
  }
  return { owner, name }
}

export function clonePathFor(repo: string): string {
  const { owner, name } = splitRepo(repo)
  return join(workbenchDir(), owner, name)
}

export function worktreePathFor(repo: string, issueNumber: number): string {
  const { owner, name } = splitRepo(repo)
  return join(workbenchDir(), 'worktrees', owner, name, `aalai-issue-${issueNumber}`)
}

/**
 * Clones the repository if it is missing, then brings its refs up to date.
 *
 * Existence is checked on the filesystem rather than by running `git rev-parse`
 * in the target: Bun.spawn throws ENOENT when its `cwd` does not exist, so
 * probing with a subprocess would fail before git could answer, and the very
 * first run against a new repository could never get as far as cloning it.
 */
export async function ensureClone(repo: string): Promise<string> {
  const clonePath = clonePathFor(repo)
  const { owner } = splitRepo(repo)
  mkdirSync(join(workbenchDir(), owner), { recursive: true })

  if (!existsSync(join(clonePath, '.git'))) {
    log.info('cloning', { repo, into: clonePath })
    await execOrThrow(['gh', 'repo', 'clone', repo, clonePath])
  }
  await git.fetchOrigin(clonePath)
  return clonePath
}

/**
 * Produces a clean worktree branched from the repository's current default branch.
 *
 * Every run gets its own worktree rather than reusing a checkout, so a previous
 * run's leftovers can never leak into this one's diff, and two runs on the same
 * repository cannot collide.
 */
export async function prepareWorkspace(
  repo: string,
  issueNumber: number,
  issueTitle: string,
): Promise<Workspace> {
  const clonePath = await ensureClone(repo)
  const base = await git.defaultBranch(clonePath)
  const branch = git.issueBranchName(issueNumber, issueTitle)
  const worktreePath = worktreePathFor(repo, issueNumber)

  // A worktree left behind by an earlier attempt would make `worktree add` fail.
  await git.removeWorktree(clonePath, worktreePath)
  await exec(['git', 'branch', '-D', branch], { cwd: clonePath })

  mkdirSync(join(worktreePath, '..'), { recursive: true })
  await git.addWorktree(clonePath, worktreePath, branch, base)
  log.info('worktree ready', { path: worktreePath, branch, base })

  return { repo, clonePath, worktreePath, branch, base }
}

export async function discardWorkspace(workspace: Workspace): Promise<void> {
  await git.removeWorktree(workspace.clonePath, workspace.worktreePath)
  log.debug('worktree removed', { path: workspace.worktreePath })
}
