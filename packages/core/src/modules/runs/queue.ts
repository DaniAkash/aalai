export type { QueueEntry }

import type { Database } from 'bun:sqlite'
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm'
import { query } from '@/modules/db/query'
import type { RunStatus, SubjectKind } from '@/modules/db/schema/schema'
import { runs } from '@/modules/db/schema/schema'
import { byInterest, subjectOf, toEntry } from '@/modules/runs/queue.helpers'
import type { QueueEntry } from '@/modules/runs/queue.types'

/** States a row can be in and still be waiting for, or holding, a slot. */
const LIVE: readonly RunStatus[] = ['offered', 'queued', 'running', 'blocked']

/**
 * Records that something exists, without starting anything.
 *
 * This is the whole point of the queue. A watcher may spend one API call and
 * write a row; it may not claim, check out, or spawn an agent. On a repository
 * with thirty open pull requests that is the difference between a laptop that
 * keeps working and one that does not.
 *
 * Idempotent on the primary key, like every other write to this table, so a
 * repeated observation is harmless. An existing row is never downgraded: a run
 * already queued, running or finished stays where it is.
 */
export function offerRun(
  db: Database,
  input: {
    readonly repo: string
    readonly kind: SubjectKind
    readonly number: number
    readonly title?: string
  },
): boolean {
  const now = new Date().toISOString()
  const result = query(db)
    .insert(runs)
    .values({
      repo: input.repo,
      subjectKind: input.kind,
      subjectNumber: input.number,
      status: 'offered',
      title: input.title ?? null,
      offeredAt: now,
      startedAt: now,
    })
    .onConflictDoNothing()
    .returning({ repo: runs.repo })
    .all()
  return result.length > 0
}

/**
 * Puts a run in line.
 *
 * `queuedAt` is set here rather than at discovery, because the queue is ordered
 * by when a person asked for something, not by when the watcher happened to see
 * it. An offer from this morning that you queue now goes behind one you queued
 * an hour ago.
 */
export function enqueueRun(
  db: Database,
  repo: string,
  kind: SubjectKind,
  number: number,
): boolean {
  const changed = query(db)
    .update(runs)
    .set({ status: 'queued', queuedAt: new Date().toISOString(), error: null })
    .where(
      and(
        subjectOf(repo, kind, number),
        // Anything but a run already queued or holding a slot. Re-queueing a
        // stopped, failed or delivered run is how "try again" works.
        notInArray(runs.status, ['queued', 'running']),
      ),
    )
    .returning({ repo: runs.repo })
    .all()
  return changed.length > 0
}

/** Takes a run out of the queue, or dismisses an offer, without deleting history. */
export function dismissRun(
  db: Database,
  repo: string,
  kind: SubjectKind,
  number: number,
): boolean {
  const changed = query(db)
    .update(runs)
    .set({ status: 'skipped', finishedAt: new Date().toISOString() })
    .where(
      and(
        subjectOf(repo, kind, number),
        inArray(runs.status, ['offered', 'queued']),
      ),
    )
    .returning({ repo: runs.repo })
    .all()
  return changed.length > 0
}

/** How many runs hold a slot right now. */
export function runningCount(db: Database): number {
  return query(db)
    .select({ repo: runs.repo })
    .from(runs)
    .where(eq(runs.status, 'running'))
    .all().length
}

/**
 * The next run to start, oldest first.
 *
 * First in, first out rather than round robin per repository: somebody who
 * queued five things from one repository has said what they want, and
 * reordering their choices to be fair to a repository they did not queue would
 * be the tool overriding them.
 */
export function nextQueued(db: Database): QueueEntry | undefined {
  return query(db)
    .select()
    .from(runs)
    .where(eq(runs.status, 'queued'))
    .orderBy(asc(runs.queuedAt))
    .limit(1)
    .all()
    .map(toEntry)[0]
}

export function listQueue(db: Database, status?: RunStatus): QueueEntry[] {
  const rows =
    status === undefined
      ? query(db).select().from(runs).all()
      : query(db).select().from(runs).where(eq(runs.status, status)).all()
  return rows.map(toEntry).sort(byInterest)
}

/** Everything still in play, for the inbox and the tray count. */
export function liveQueue(db: Database): QueueEntry[] {
  return query(db)
    .select()
    .from(runs)
    .where(inArray(runs.status, [...LIVE]))
    .all()
    .map(toEntry)
    .sort(byInterest)
}

export function readRun(
  db: Database,
  repo: string,
  kind: SubjectKind,
  number: number,
): QueueEntry | undefined {
  return query(db)
    .select()
    .from(runs)
    .where(subjectOf(repo, kind, number))
    .all()
    .map(toEntry)[0]
}

/**
 * Promotes the oldest queued run, but only if a slot is genuinely free.
 *
 * One statement, because a read of the running count followed by a separate
 * claim is a race: two pollers, or a poll and a Start button, can both see the
 * last free slot and both take it. The count is a subquery here so the check
 * and the claim cannot be interleaved.
 */
export function claimNextQueued(
  db: Database,
  capacity: number,
): { entry: QueueEntry; lease: string } | undefined {
  const lease = crypto.randomUUID()
  const now = new Date().toISOString()
  const promoted = db
    .query<
      { repo: string; subject_kind: SubjectKind; subject_number: number },
      [string, string, number]
    >(
      `UPDATE runs
          SET status = 'running', lease = ?, started_at = ?
        WHERE rowid = (
                SELECT rowid FROM runs
                 WHERE status = 'queued'
                 ORDER BY queued_at ASC
                 LIMIT 1
              )
          AND (SELECT COUNT(*) FROM runs WHERE status = 'running') < ?
      RETURNING repo, subject_kind, subject_number`,
    )
    .get(lease, now, capacity)
  if (promoted === null) {
    return undefined
  }
  const entry = readRun(
    db,
    promoted.repo,
    promoted.subject_kind,
    promoted.subject_number,
  )
  return entry === undefined ? undefined : { entry, lease }
}

/**
 * Claims one named queued run, if a slot is free.
 *
 * The Start button's path. Same ceiling, same single statement, so it cannot
 * race the scheduler for the last slot.
 */
export function claimQueuedSubject(
  db: Database,
  repo: string,
  kind: SubjectKind,
  number: number,
  capacity: number,
): { entry: QueueEntry; lease: string } | undefined {
  const lease = crypto.randomUUID()
  const now = new Date().toISOString()
  const promoted = db
    .query<
      { repo: string },
      [string, string, string, SubjectKind, number, number]
    >(
      `UPDATE runs
          SET status = 'running', lease = ?, started_at = ?
        WHERE repo = ? AND subject_kind = ? AND subject_number = ?
          AND status = 'queued'
          AND (SELECT COUNT(*) FROM runs WHERE status = 'running') < ?
      RETURNING repo`,
    )
    .get(lease, now, repo, kind, number, capacity)
  if (promoted === null) {
    return undefined
  }
  const entry = readRun(db, repo, kind, number)
  return entry === undefined ? undefined : { entry, lease }
}

/**
 * Lets a run that was waiting on a person back into the running set.
 *
 * Capacity bounded for the same reason as promotion: answering three gates at
 * once must not start three runs on a machine that allows two.
 */
export function readmitRun(
  db: Database,
  repo: string,
  kind: SubjectKind,
  number: number,
  capacity: number,
): boolean {
  const changed = db
    .query<{ repo: string }, [string, SubjectKind, number, number]>(
      `UPDATE runs
          SET status = 'running'
        WHERE repo = ? AND subject_kind = ? AND subject_number = ?
          AND status = 'blocked'
          AND (SELECT COUNT(*) FROM runs WHERE status = 'running') < ?
      RETURNING repo`,
    )
    .get(repo, kind, number, capacity)
  return changed !== null
}

/**
 * Whether a run that was waiting on a person may carry on now.
 *
 * A run only needs a slot back if it gave one up. Anything that is not blocked
 * never left the running set, so there is nothing to readmit and saying no
 * would strand it: the gate would be answered and the machine would never be
 * told. Only a genuinely blocked run on a full machine waits.
 */
export function resumeAfterGate(
  db: Database,
  repo: string,
  kind: SubjectKind,
  number: number,
  capacity: number,
): boolean {
  const row = readRun(db, repo, kind, number)
  if (row?.status !== 'blocked') {
    return true
  }
  return readmitRun(db, repo, kind, number, capacity)
}

/**
 * Releases a run's slot while it waits for a person.
 *
 * A gate can wait for days. If a blocked run kept its slot, a factory with
 * three slots and three unanswered gates would be permanently idle while
 * appearing busy.
 */
export function blockRun(
  db: Database,
  repo: string,
  kind: SubjectKind,
  number: number,
): boolean {
  const changed = query(db)
    .update(runs)
    // The lease is kept. The machine that opened this gate is still holding
    // the run and will settle it with that token when the gate is answered;
    // clearing it here would make its own completion silently discarded.
    .set({ status: 'blocked' })
    .where(and(subjectOf(repo, kind, number), eq(runs.status, 'running')))
    .returning({ repo: runs.repo })
    .all()
  return changed.length > 0
}
