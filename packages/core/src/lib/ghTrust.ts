import { gh } from '@/lib/ghExec'

/**
 * What GitHub can say about who wrote a change and what they are trusted with.
 *
 * Separate from the rest of the pull request reads because it answers a different
 * question. Those are about what a pull request is doing; these are about whether
 * its contents may be executed, which is the one question in the product whose
 * wrong answer runs somebody else's code on this machine.
 */

export interface CommitAuthorship {
  readonly sha: string
  /**
   * The GitHub account the commit's email resolves to, or null.
   *
   * Null is the interesting case and it is not an error: a commit whose author
   * email belongs to no account is code from somebody this repository has never
   * trusted, whoever opened the pull request carrying it.
   *
   * A login here is attribution and not proof. Anybody can set
   * `git config user.email` to a trusted account's public address and GitHub will
   * resolve this to that account, so a login alone must never be enough to run
   * code unattended.
   */
  readonly authorLogin: string | null
  readonly authorName: string
  /**
   * Whether the commit carries a signature GitHub could verify.
   *
   * The difference between a claim and a proof. Without it the email is the only
   * thing linking a commit to an account, and an email is a field somebody
   * chose.
   */
  readonly verified: boolean
}

export interface PullRequestOrigin {
  /** The association of whoever opened it, which governs its text. */
  readonly association: string
  /** Whether the head lives in another repository. */
  readonly isFork: boolean
  readonly headRepo: string
}

/** Who wrote each commit on a pull request, oldest first. */
export async function pullRequestCommits(
  repo: string,
  number: number,
): Promise<CommitAuthorship[]> {
  const stdout = await gh([
    'api',
    '--paginate',
    `repos/${repo}/pulls/${number}/commits`,
    '--jq',
    '.[] | {sha, authorLogin: .author.login, authorName: .commit.author.name, verified: .commit.verification.verified}',
  ])
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CommitAuthorship)
}

/** Where a pull request came from, as distinct from what is in it. */
export async function pullRequestOrigin(
  repo: string,
  number: number,
): Promise<PullRequestOrigin> {
  const raw = await gh([
    'api',
    `repos/${repo}/pulls/${number}`,
    '--jq',
    '{association: .author_association, isFork: .head.repo.fork, headRepo: .head.repo.full_name}',
  ])
  return JSON.parse(raw) as PullRequestOrigin
}

/**
 * What a repository has granted one account, or `none`.
 *
 * `read` is what GitHub answers for anybody at all on a public repository, so
 * it is not a grant and must not read as one.
 */
export async function repoPermission(
  repo: string,
  login: string,
): Promise<string> {
  try {
    const raw = await gh([
      'api',
      `repos/${repo}/collaborators/${login}/permission`,
      '--jq',
      '.permission',
    ])
    return raw.trim()
  } catch {
    return 'none'
  }
}

/**
 * The diff of a pull request, as text.
 *
 * Which is all a static review gets, and the reason is not convenience. No
 * permission mode prevents an agent running a shell command, established by
 * `scripts/permission-probe.ts`, so the only way to be sure a stranger's code
 * does not execute is for it not to be on disk where the agent is working. Text
 * in a prompt cannot be run.
 */
export async function pullRequestDiff(
  repo: string,
  number: number,
): Promise<string> {
  return gh(['pr', 'diff', String(number), '--repo', repo])
}
