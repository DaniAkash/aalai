/**
 * The second trust question: may this code run on my machine.
 *
 * Q1, in `watch/intake.ts`, asks whether text may become instructions to an
 * agent. This asks whether code may become a process, and the two are not the
 * same question with a flag: a maintainer can open a pull request carrying
 * somebody else's commits, which passes Q1 on the strength of who opened it and
 * says nothing at all about who wrote what is in it.
 *
 * It lives beside the run rather than beside the intake screen, which is a
 * boundary fallow pointed out and was right about. Q1 decides whether a run
 * starts at all, which is the watching layer's job. Q2 is asked inside a run,
 * about code that run is already reading.
 *
 * So this reads the commits rather than the opener. A commit whose author email
 * resolves to no GitHub account, or to an account this repository has granted
 * nothing, is code from a stranger however it arrived.
 */

import {
  pullRequestCommits,
  pullRequestOrigin,
  repoPermission,
} from '@/lib/ghPr'
import { logger } from '@/lib/log'

const log = logger('trust')

/** Permissions that amount to the repository trusting an account. */
const TRUSTED_PERMISSIONS: ReadonlySet<string> = new Set([
  'admin',
  'maintain',
  'write',
])

export interface Authorship {
  readonly sha: string
  readonly authorLogin: string | null
  readonly authorName: string
  readonly verified: boolean
}

export type ExecutionVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string }

/**
 * Whether the code on this head may be executed without asking anybody.
 *
 * Every commit has to clear it. One unrecognised commit among twenty trusted
 * ones is still a stranger's code in the checkout, and running the suite runs
 * all of it.
 */
export function mayExecute(input: {
  commits: readonly Authorship[]
  isFork: boolean
  /** What the repository has granted each login, from `repoPermission`. */
  permissions: ReadonlyMap<string, string>
  /**
   * Whether a signature is required before code runs. Defaults to requiring one.
   *
   * Off is a repository saying that write access is its trust boundary and that
   * an email is what links a commit to an account. That is a weaker position and
   * it is the one most repositories are actually in, because most commits are
   * unsigned: left on, every pull request waits for a person, which is safe and
   * is not the same as the contributor path working.
   */
  requireSigned?: boolean
}): ExecutionVerdict {
  if (input.commits.length === 0) {
    // Nothing read, rather than nothing to worry about. A head whose commits
    // could not be listed is a head nobody has looked at.
    return {
      allowed: false,
      reason: 'the commits on this head could not be read',
    }
  }

  if (input.isFork) {
    // A fork can move under us between the read and the checkout, so even
    // trusted authorship on one does not license running it unattended.
    return { allowed: false, reason: 'the head is in another repository' }
  }

  const unknown = input.commits.filter(
    (commit) => commit.authorLogin === null || commit.authorLogin === '',
  )
  if (unknown.length > 0) {
    const names = [...new Set(unknown.map((c) => c.authorName))].join(', ')
    return {
      allowed: false,
      reason: `${unknown.length === 1 ? 'a commit' : `${unknown.length} commits`} by an account this repository does not know (${names})`,
    }
  }

  // A signature, or a person. An author email is a field somebody chose, so
  // anybody can set it to a trusted account's public address and be resolved to
  // that account. That is enough to attribute a commit and nowhere near enough
  // to run it, so an unsigned commit is asked about however trusted it looks.
  const unproven =
    input.requireSigned === false
      ? []
      : input.commits.filter((commit) => !commit.verified)
  if (unproven.length > 0) {
    return {
      allowed: false,
      reason: `${unproven.length === 1 ? 'a commit' : `${unproven.length} commits`} nobody signed, so who wrote them is a claim rather than a fact`,
    }
  }

  const untrusted = input.commits.filter((commit) => {
    const granted = input.permissions.get(commit.authorLogin ?? '') ?? 'none'
    return !TRUSTED_PERMISSIONS.has(granted)
  })
  if (untrusted.length > 0) {
    const logins = [
      ...new Set(untrusted.map((c) => c.authorLogin ?? 'somebody')),
    ].join(', ')
    return {
      allowed: false,
      reason: `commits by ${logins}, who this repository has not granted write access`,
    }
  }

  return { allowed: true }
}

/** Every login worth asking about, so the same one is not looked up twice. */
export function authorsToResolve(
  commits: readonly Authorship[],
): readonly string[] {
  return [
    ...new Set(
      commits
        .map((commit) => commit.authorLogin)
        .filter((login): login is string => login !== null && login !== ''),
    ),
  ]
}

/**
 * Asks GitHub everything needed to answer Q2, and answers it.
 *
 * The reads are here rather than in the machine because they are three calls
 * that only mean anything together, and because the answer is a fact about a
 * head rather than a state anything holds.
 */
export async function screenExecution(
  repo: string,
  prNumber: number,
  requireSigned = true,
): Promise<ExecutionVerdict> {
  const [origin, commits] = await Promise.all([
    pullRequestOrigin(repo, prNumber),
    pullRequestCommits(repo, prNumber),
  ])
  const permissions = new Map<string, string>()
  for (const login of authorsToResolve(commits)) {
    permissions.set(login, await repoPermission(repo, login))
  }
  const verdict = mayExecute({
    commits,
    isFork: origin.isFork,
    permissions,
    requireSigned,
  })
  log.info('decided whether this code may run', {
    repo,
    pr: prNumber,
    allowed: verdict.allowed,
    ...(verdict.allowed ? {} : { because: verdict.reason }),
  })
  return verdict
}
