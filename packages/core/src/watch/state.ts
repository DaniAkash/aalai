import type { Database } from 'bun:sqlite'
import { and, desc, eq, lt, or } from 'drizzle-orm'
import { openDb } from '@/modules/db/db'
import { query } from '@/modules/db/query'
import { cursor, runs } from '@/modules/db/schema/schema'

export type { RunStatus } from '@/modules/db/schema/schema'

import type { RunStatus, SubjectKind } from '@/modules/db/schema/schema'

/**
 * The shape the interface and the API already render.
 *
 * Snake case and `issue` rather than the schema's `subject_number`, because
 * every issue is a subject but the callers of this module only deal in issues
 * until pull requests arrive as runs of their own.
 */
export interface RunRecord {
  readonly repo: string
  readonly issue: number
  readonly status: RunStatus
  readonly branch: string | null
  readonly pr_url: string | null
  readonly error: string | null
}

/** Every run this module claims is about an issue. Pull requests arrive later. */
const ISSUE = 'issue' as const

export function openState(path?: string): Database {
  return openDb(path).sqlite
}

export function readCursor(db: Database, repo: string): string | null {
  const row = query(db)
    .select({ lastSeenAt: cursor.lastSeenAt })
    .from(cursor)
    .where(eq(cursor.repo, repo))
    .get()
  return row?.lastSeenAt ?? null
}

export function writeCursor(db: Database, repo: string, iso: string): void {
  query(db)
    .insert(cursor)
    .values({ repo, lastSeenAt: iso })
    .onConflictDoUpdate({ target: cursor.repo, set: { lastSeenAt: iso } })
    .run()
}

/**
 * Claims an issue for exactly one run, or takes over a claim that went stale.
 *
 * Polling has no delivery-once guarantee and a tick can overlap its predecessor,
 * so the primary key plus a conflict-guarded insert is what makes a duplicate
 * observation harmless. The staleness clause is the other half: a process killed
 * mid-run leaves a row stuck in `claimed`, and without a lease every later poll
 * would read that row as a completed duplicate and skip the issue forever.
 *
 * @returns The lease token when this caller now owns the run.
 */
export function claimRun(
  db: Database,
  repo: string,
  issue: number,
  staleAfterMs = 30 * 60 * 1000,
  /** Which kind of subject is being claimed. A pull request claims like an issue. */
  kind: SubjectKind = ISSUE,
): string | null {
  const now = new Date()
  const lease = crypto.randomUUID()
  const staleBefore = new Date(now.getTime() - staleAfterMs).toISOString()
  const result = query(db)
    .insert(runs)
    .values({
      repo,
      subjectKind: kind,
      subjectNumber: issue,
      status: 'running',
      lease,
      queuedAt: now.toISOString(),
      offeredAt: now.toISOString(),
      startedAt: now.toISOString(),
    })
    .onConflictDoUpdate({
      target: [runs.repo, runs.subjectKind, runs.subjectNumber],
      set: {
        status: 'running',
        startedAt: now.toISOString(),
        lease,
        error: null,
      },
      // Two ways a row may be claimed. The scheduler promoting something a
      // person queued is the ordinary one. Taking over a run whose process
      // died is the other, and it still needs the staleness clause, because
      // without it every later poll would steal a live worker's run.
      setWhere: or(
        eq(runs.status, 'queued'),
        and(eq(runs.status, 'running'), lt(runs.startedAt, staleBefore)),
      ),
    })
    .returning({ lease: runs.lease })
    .all()
  return result.length > 0 ? lease : null
}

/**
 * Records a run's outcome.
 *
 * The lease is the fence. A run that outlives its lease can have its issue taken
 * over by a later pass, and without checking the token the original worker would
 * later overwrite the newer run's result, because the subject alone matches
 * both. A stale worker's write is dropped instead.
 *
 * @returns Whether the write was applied.
 */
export function completeRun(
  db: Database,
  repo: string,
  issue: number,
  outcome: {
    readonly status: Exclude<RunStatus, 'running'>
    readonly branch?: string
    readonly prUrl?: string
    readonly error?: string
    readonly lease?: string
    /** Which subject is being completed. A pull request completes like an issue. */
    readonly kind?: SubjectKind
  },
): boolean {
  const subject = and(
    eq(runs.repo, repo),
    eq(runs.subjectKind, outcome.kind ?? ISSUE),
    eq(runs.subjectNumber, issue),
  )
  const result = query(db)
    .update(runs)
    .set({
      status: outcome.status,
      branch: outcome.branch ?? null,
      prUrl: outcome.prUrl ?? null,
      error: outcome.error ?? null,
      finishedAt: new Date().toISOString(),
    })
    .where(
      outcome.lease === undefined
        ? subject
        : and(subject, eq(runs.lease, outcome.lease)),
    )
    .returning({ repo: runs.repo })
    .all()
  return result.length > 0
}

export function listRuns(db: Database, limit = 20): RunRecord[] {
  return query(db)
    .select({
      repo: runs.repo,
      issue: runs.subjectNumber,
      status: runs.status,
      branch: runs.branch,
      pr_url: runs.prUrl,
      error: runs.error,
    })
    .from(runs)
    .where(eq(runs.subjectKind, ISSUE))
    .orderBy(desc(runs.startedAt))
    .limit(limit)
    .all()
}

/**
 * Takes over a claim whose process is gone, for resuming.
 *
 * claimRun waits for the lease to go stale, which is right when the question
 * is "did somebody abandon this". Here the question is different: a snapshot
 * on disk says the work exists and this process intends to finish it. The
 * update is still conditional, so two pollers racing to resume the same run
 * produce one winner and one null rather than two live machines.
 *
 * @returns The new lease when this caller now owns the run.
 */
export function takeOverRun(
  db: Database,
  repo: string,
  issue: number,
  /**
   * How long a claim has to have been quiet before it counts as abandoned.
   *
   * Only an abandoned one may be taken over, which was always what this claimed
   * to do and did not: it replaced the lease on any claimed row at all. With a
   * short run that was survivable, because the pass holding the claim also held
   * the poller and nothing else was looking. A watch that runs for days and
   * renews its claim is looked at by every pass, and taking it over started a
   * second watcher on the same branch while the first was still pushing to it.
   */
  staleAfterMs: number,
  /** Which subject is being taken over. A pull request resumes like an issue. */
  kind: SubjectKind = ISSUE,
): string | null {
  const lease = crypto.randomUUID()
  const staleBefore = new Date(Date.now() - staleAfterMs).toISOString()
  const result = query(db)
    .update(runs)
    .set({ lease, startedAt: new Date().toISOString() })
    .where(
      and(
        eq(runs.repo, repo),
        eq(runs.subjectKind, kind),
        eq(runs.subjectNumber, issue),
        eq(runs.status, 'running'),
        lt(runs.startedAt, staleBefore),
      ),
    )
    .returning({ repo: runs.repo })
    .all()
  return result.length > 0 ? lease : null
}

/** Removes a run record so the issue can be picked up again. The manual retry path. */
export function forgetRun(db: Database, repo: string, issue: number): boolean {
  const result = query(db)
    .delete(runs)
    .where(
      and(
        eq(runs.repo, repo),
        eq(runs.subjectKind, ISSUE),
        eq(runs.subjectNumber, issue),
      ),
    )
    .returning({ repo: runs.repo })
    .all()
  return result.length > 0
}

/**
 * Says a claim is still being worked on.
 *
 * A lease goes stale so that a killed process does not hold a subject forever,
 * which is right for a run that takes minutes and wrong for a watch that takes
 * days: without this, a pull request being actively watched looks abandoned
 * after the stale interval and a second watcher starts on the same branch,
 * which is two revisions on one branch, the exact thing the claim prevents.
 *
 * Fenced on the lease, so a worker that has already been taken over cannot
 * revive its own claim.
 *
 * @returns Whether the claim was still ours to renew.
 */
export function renewClaim(
  db: Database,
  repo: string,
  number: number,
  lease: string,
  kind: SubjectKind = ISSUE,
): boolean {
  const result = query(db)
    .update(runs)
    .set({ startedAt: new Date().toISOString() })
    .where(
      and(
        eq(runs.repo, repo),
        eq(runs.subjectKind, kind),
        eq(runs.subjectNumber, number),
        eq(runs.status, 'running'),
        eq(runs.lease, lease),
      ),
    )
    .returning({ lease: runs.lease })
    .all()
  return result.length > 0
}

// Re-exported so the claim table reads as one thing to its callers. They live
// next door for size, not because they are a different idea.
export {
  abandonedPullRequests,
  claimedPullRequests,
  deliveredBranch,
  deliveredPullRequests,
} from '@/watch/prState'
