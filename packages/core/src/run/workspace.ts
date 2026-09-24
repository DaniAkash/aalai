import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { githubEnv } from '@/lib/credentials'
import { workbenchDir } from '@/lib/env'
import * as git from '@/lib/git'
import { logger } from '@/lib/log'
import { exec, execOrThrow } from '@/lib/proc'

const log = logger('workspace')

export interface Workspace {
  readonly repo: string
  readonly issueNumber: number
  readonly clonePath: string
  readonly worktreePath: string
  readonly branch: string
  readonly base: string
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/')
  if (
    owner === undefined ||
    name === undefined ||
    owner === '' ||
    name === ''
  ) {
    throw new Error(`Expected owner/repo, got "${repo}"`)
  }
  return { owner, name }
}

function clonePathFor(repo: string): string {
  const { owner, name } = splitRepo(repo)
  return join(workbenchDir(), owner, name)
}

function worktreePathFor(
  repo: string,
  issueNumber: number,
  suffix = '',
): string {
  const { owner, name } = splitRepo(repo)
  return join(
    workbenchDir(),
    'worktrees',
    owner,
    name,
    `aalai-issue-${issueNumber}${suffix}`,
  )
}

/**
 * Clones the repository if it is missing, then brings its refs up to date.
 *
 * Existence is checked on the filesystem rather than by running `git rev-parse`
 * in the target: Bun.spawn throws ENOENT when its `cwd` does not exist, so
 * probing with a subprocess would fail before git could answer, and the very
 * first run against a new repository could never get as far as cloning it.
 */
async function ensureClone(repo: string): Promise<string> {
  const clonePath = clonePathFor(repo)
  const { owner } = splitRepo(repo)
  mkdirSync(join(workbenchDir(), owner), { recursive: true })

  if (!existsSync(join(clonePath, '.git'))) {
    log.info('cloning', { repo, into: clonePath })
    await execOrThrow(['gh', 'repo', 'clone', repo, clonePath], {
      env: githubEnv(),
    })
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

  return { repo, issueNumber, clonePath, worktreePath, branch, base }
}

/**
 * Picks up the worktree a previous process left behind, if it is still there.
 *
 * Resuming a run means resuming its work, and its work is commits in a
 * worktree. `prepareWorkspace` deliberately destroys one to guarantee a clean
 * start, which is right for a new run and exactly wrong for a resumed one: it
 * would throw away the commits the run is being resumed to keep.
 *
 * Returns undefined when there is nothing to adopt, which is the signal to
 * start the run over rather than resume it.
 */
export async function adoptWorkspace(
  repo: string,
  issueNumber: number,
  issueTitle: string,
): Promise<Workspace | undefined> {
  const clonePath = await ensureClone(repo)
  const worktreePath = worktreePathFor(repo, issueNumber)
  if (!existsSync(join(worktreePath, '.git'))) {
    return undefined
  }

  const branch = git.issueBranchName(issueNumber, issueTitle)
  const base = await git.defaultBranch(clonePath)
  const onBranch = await exec(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: worktreePath,
  })
  if (onBranch.exitCode !== 0 || onBranch.stdout.trim() !== branch) {
    // A worktree on some other branch is not this run's worktree. Adopting it
    // would mean committing this run's work on top of somebody else's.
    log.warn('worktree found but on another branch, not adopting', {
      path: worktreePath,
      found: onBranch.stdout.trim(),
      expected: branch,
    })
    return undefined
  }

  log.info('worktree adopted', { path: worktreePath, branch, base })
  return { repo, issueNumber, clonePath, worktreePath, branch, base }
}

export async function discardWorkspace(workspace: Workspace): Promise<void> {
  await git.removeWorktree(workspace.clonePath, workspace.worktreePath)
  log.debug('worktree removed', { path: workspace.worktreePath })
}

/**
 * A second checkout of the branch, for the reviewer.
 *
 * The reviewer reads the same commits from its own working directory rather
 * than from the one the implementer just worked in. That is what makes its
 * independence structural: it cannot see uncommitted scratch, a stray file, or
 * anything about how the change was arrived at. It sees what was committed.
 */
export async function prepareReviewWorkspace(
  workspace: Workspace,
): Promise<string> {
  const path = worktreePathFor(workspace.repo, workspace.issueNumber, '-review')
  await git.removeWorktree(workspace.clonePath, path)
  mkdirSync(join(path, '..'), { recursive: true })
  await git.addExistingBranchWorktree(
    workspace.clonePath,
    path,
    workspace.branch,
  )
  log.info('review worktree ready', { path })
  return path
}

export async function discardPath(
  workspace: Workspace,
  path: string,
): Promise<void> {
  await git.removeWorktree(workspace.clonePath, path)
}
