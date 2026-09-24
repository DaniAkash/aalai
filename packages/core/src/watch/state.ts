import type { Database } from 'bun:sqlite'
import { and, desc, eq, lt } from 'drizzle-orm'
import { openDb } from '@/modules/db/db'
import { query } from '@/modules/db/query'
import { cursor, runs } from '@/modules/db/schema/schema'

export type { RunStatus } from '@/modules/db/schema/schema'

import type { RunStatus } from '@/modules/db/schema/schema'

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
): string | null {
  const now = new Date()
  const lease = crypto.randomUUID()
  const staleBefore = new Date(now.getTime() - staleAfterMs).toISOString()
  const result = query(db)
    .insert(runs)
    .values({
      repo,
      subjectKind: ISSUE,
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
  },
): boolean {
  const subject = and(
    eq(runs.repo, repo),
    eq(runs.subjectKind, ISSUE),
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
