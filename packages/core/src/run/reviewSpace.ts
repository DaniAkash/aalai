import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { githubEnv } from '@/lib/credentials'
import { logger } from '@/lib/log'
import { exec, execOrThrow } from '@/lib/proc'

const log = logger('review')

/**
 * Somewhere for a review to work that reaches nothing it should not.
 *
 * This exists because of a mistake worth recording. The reading half of a review
 * was given a worktree of our own clone of the repository, on the theory that the
 * contributor's branch was not checked out there so their code was not present.
 * It was present: a worktree shares its clone's objects and refs, so
 * `git show origin/their-branch:file` prints their code from inside it, and the
 * agent doing the reading has an ungated shell. The check that was supposed to
 * prove otherwise looked at the working tree and missed it entirely.
 *
 * So the reading half gets a directory with no git repository in it at all.
 * Nothing to enumerate, nothing to fetch from, no refs, no objects.
 */
export async function emptySpace(): Promise<{
  path: string
  discard: () => Promise<void>
}> {
  const path = await mkdtemp(join(tmpdir(), 'aalai-review-'))
  return {
    path,
    discard: async () => {
      await rm(path, { recursive: true, force: true })
    },
  }
}

/**
 * A checkout of exactly one commit, from wherever that commit lives.
 *
 * Fetched by sha rather than by branch, into a repository of its own rather than
 * a worktree of ours, for three reasons that are all the same reason. A branch is
 * mutable, so a force push between a person clearing a commit and this running it
 * would run something they never saw. A fork's branch does not exist on our
 * remote at all. And a worktree of our clone can reach everything our clone can,
 * which is the whole of the repository including refs this review has no business
 * with.
 */
export async function checkoutCommit(input: {
  /** Where the commit lives, which is not our repository for a fork. */
  headRepo: string
  sha: string
}): Promise<{ path: string; discard: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'aalai-run-'))
  const env = githubEnv()
  // Every way out of here that is not success removes the directory. Without
  // this a failed fetch left one behind, because the caller's cleanup only runs
  // once this has returned something for it to clean up.
  try {
    await execOrThrow(['git', 'init', '--quiet'], { cwd: path })
    await execOrThrow(
      [
        'git',
        'fetch',
        '--depth',
        '1',
        `https://github.com/${input.headRepo}.git`,
        input.sha,
      ],
      { cwd: path, env },
    )
    await execOrThrow(['git', 'checkout', '--quiet', 'FETCH_HEAD'], {
      cwd: path,
    })

    // Checked rather than assumed. The point of fetching a sha is that what is
    // here is what somebody cleared, and saying so only matters if it is true.
    const at = await exec(['git', 'rev-parse', 'HEAD'], { cwd: path })
    const head = at.stdout.trim()
    if (head !== input.sha) {
      throw new Error(
        `checked out ${head.slice(0, 8)} but ${input.sha.slice(0, 8)} was the commit cleared to run`,
      )
    }
  } catch (error) {
    await rm(path, { recursive: true, force: true })
    throw error
  }
  log.info('checked out exactly the commit that was cleared', {
    repo: input.headRepo,
    sha: input.sha.slice(0, 8),
  })
  return {
    path,
    discard: async () => {
      await rm(path, { recursive: true, force: true })
    },
  }
}
