import { githubEnv } from '@/lib/credentials'
import { assertSafeBranch } from '@/lib/git'
import { exec, execOrThrow } from '@/lib/proc'

/**
 * Adding and removing worktrees.
 *
 * Beside the rest of the git helpers rather than among them: every run gets its
 * own checkout and these are the four operations that make and unmake one, which
 * is a different job from reading a diff or making a commit.
 */

export async function removeWorktree(
  repoDir: string,
  worktreePath: string,
): Promise<void> {
  await exec(['git', 'worktree', 'remove', '--force', worktreePath], {
    cwd: repoDir,
  })
  await exec(['git', 'worktree', 'prune'], { cwd: repoDir })
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

/**
 * Adds a worktree with a branch actually checked out, not detached.
 *
 * The detached variant above is for reading somebody's code. This one is for
 * carrying on working on a branch of ours, so the branch has to be checked out
 * or a commit would land nowhere and a push would have nothing to push.
 *
 * The branch is fetched first, because the local one can be behind whatever is
 * on the pull request: a person may have pushed to it, and a worktree on a stale
 * local branch would quietly build on the wrong commit.
 */
export async function addBranchWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  assertSafeBranch(branch)
  await execOrThrow(
    [
      'git',
      'fetch',
      'origin',
      `refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    { cwd: repoDir, env: githubEnv() },
  )
  await execOrThrow(
    [
      'git',
      'worktree',
      'add',
      '-B',
      branch,
      worktreePath,
      `refs/remotes/origin/${branch}`,
    ],
    { cwd: repoDir },
  )
}
