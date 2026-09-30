import type { Database } from 'bun:sqlite'
import { and, eq, lt } from 'drizzle-orm'
import { query } from '@/modules/db/query'
import { runs } from '@/modules/db/schema/schema'

const ISSUE = 'issue' as const

/**
 * What the claim table knows about pull requests.
 *
 * Beside the rest of the claim handling rather than among it, because these four
 * are all about a `pr` subject and the rest is about starting and finishing any
 * subject at all.
 */

/**
 * The branch a pull request was delivered on, whatever is watching it.
 *
 * Separate from the unwatched listing, which deliberately excludes anything that
 * already has a run. Resuming one is exactly the case where the row is present,
 * so reading the branch through that filter returned nothing and the resumed
 * watch tried to build a checkout for an empty branch name.
 */
export function deliveredBranch(
  db: Database,
  repo: string,
  prNumber: number,
): { branch: string; issueNumber: number } | undefined {
  const rows = query(db)
    .select({
      issueNumber: runs.subjectNumber,
      prUrl: runs.prUrl,
      branch: runs.branch,
    })
    .from(runs)
    .where(and(eq(runs.repo, repo), eq(runs.subjectKind, ISSUE)))
    .all()
  for (const row of rows) {
    if (Number((row.prUrl ?? '').split('/').pop()) === prNumber) {
      return { branch: row.branch ?? '', issueNumber: row.issueNumber }
    }
  }
  return undefined
}

/**
 * Pull request watches whose worker went away.
 *
 * A claim that has gone quiet past the stale window, on a row still marked
 * claimed. The watch layer picks these up itself rather than the issue resume
 * path doing it, because it is the half that knows these are long lived and
 * have to be started detached.
 */
export function abandonedPullRequests(
  db: Database,
  staleAfterMs: number,
): { repo: string; prNumber: number }[] {
  const staleBefore = new Date(Date.now() - staleAfterMs).toISOString()
  return query(db)
    .select({ repo: runs.repo, prNumber: runs.subjectNumber })
    .from(runs)
    .where(
      and(
        eq(runs.subjectKind, 'pr'),
        eq(runs.status, 'claimed'),
        lt(runs.startedAt, staleBefore),
      ),
    )
    .all()
}

/**
 * Pull requests already claimed, so a second pass does not claim them again.
 *
 * Shared by the two things that claim a `pr` subject: keeping our own alive and
 * reviewing somebody else's. They are different runs on the same kind of
 * subject, and neither should start where the other is already working.
 */
export function claimedPullRequests(db: Database): Set<string> {
  return new Set(
    query(db)
      .select({ repo: runs.repo, number: runs.subjectNumber })
      .from(runs)
      .where(eq(runs.subjectKind, 'pr'))
      .all()
      .map((row) => `${row.repo}#${row.number}`),
  )
}

/**
 * Pull requests the factory delivered that nothing is watching yet.
 *
 * A delivered issue run carries the pull request's URL and the branch it was
 * built on. A pull request already being watched has a run of its own on a `pr`
 * subject, so the ones worth starting are the delivered issues whose pull
 * request has no such row.
 */

export function deliveredPullRequests(db: Database): {
  repo: string
  issueNumber: number
  prNumber: number
  branch: string
}[] {
  const delivered = query(db)
    .select({
      repo: runs.repo,
      issueNumber: runs.subjectNumber,
      prUrl: runs.prUrl,
      branch: runs.branch,
    })
    .from(runs)
    .where(and(eq(runs.subjectKind, ISSUE), eq(runs.status, 'delivered')))
    .all()

  const watched = new Set(
    query(db)
      .select({ repo: runs.repo, number: runs.subjectNumber })
      .from(runs)
      .where(eq(runs.subjectKind, 'pr'))
      .all()
      .map((row) => `${row.repo}#${row.number}`),
  )

  const open: {
    repo: string
    issueNumber: number
    prNumber: number
    branch: string
  }[] = []
  for (const row of delivered) {
    const prNumber = Number((row.prUrl ?? '').split('/').pop())
    if (!Number.isFinite(prNumber) || prNumber <= 0) {
      continue
    }
    if (watched.has(`${row.repo}#${prNumber}`)) {
      continue
    }
    open.push({
      repo: row.repo,
      issueNumber: row.issueNumber,
      prNumber,
      branch: row.branch ?? '',
    })
  }
  return open
}
