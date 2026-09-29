import type { Database } from 'bun:sqlite'
import { and, desc, eq, lt } from 'drizzle-orm'
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
      status: 'claimed',
      lease,
      startedAt: now.toISOString(),
    })
    .onConflictDoUpdate({
      target: [runs.repo, runs.subjectKind, runs.subjectNumber],
      set: { startedAt: now.toISOString(), lease, error: null },
      setWhere: and(
        eq(runs.status, 'claimed'),
        lt(runs.startedAt, staleBefore),
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
    readonly status: Exclude<RunStatus, 'claimed'>
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
): string | null {
  const lease = crypto.randomUUID()
  const result = query(db)
    .update(runs)
    .set({ lease, startedAt: new Date().toISOString() })
    .where(
      and(
        eq(runs.repo, repo),
        eq(runs.subjectKind, ISSUE),
        eq(runs.subjectNumber, issue),
        eq(runs.status, 'claimed'),
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
