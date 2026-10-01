import type { Database } from 'bun:sqlite'
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm'
import { query } from '@/modules/db/query'
import type { RunStatus, SubjectKind } from '@/modules/db/schema/schema'
import { runs } from '@/modules/db/schema/schema'

export interface QueueEntry {
  readonly repo: string
  readonly kind: SubjectKind
  readonly number: number
  readonly status: RunStatus
  readonly title: string | null
  readonly offeredAt: string | null
  readonly queuedAt: string | null
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly branch: string | null
  readonly prUrl: string | null
  readonly error: string | null
}

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
    .set({ status: 'blocked', lease: null })
    .where(and(subjectOf(repo, kind, number), eq(runs.status, 'running')))
    .returning({ repo: runs.repo })
    .all()
  return changed.length > 0
}

function subjectOf(repo: string, kind: SubjectKind, number: number) {
  return and(
    eq(runs.repo, repo),
    eq(runs.subjectKind, kind),
    eq(runs.subjectNumber, number),
  )
}

/** Most interesting first: what needs a person, then what is moving, then the rest. */
const ORDER: Record<RunStatus, number> = {
  blocked: 0,
  running: 1,
  queued: 2,
  offered: 3,
  failed: 4,
  stopped: 5,
  delivered: 6,
  skipped: 7,
}

function byInterest(a: QueueEntry, b: QueueEntry): number {
  const rank = ORDER[a.status] - ORDER[b.status]
  if (rank !== 0) {
    return rank
  }
  return (a.queuedAt ?? a.offeredAt ?? a.startedAt).localeCompare(
    b.queuedAt ?? b.offeredAt ?? b.startedAt,
  )
}

function toEntry(row: typeof runs.$inferSelect): QueueEntry {
  return {
    repo: row.repo,
    kind: row.subjectKind,
    number: row.subjectNumber,
    status: row.status,
    title: row.title,
    offeredAt: row.offeredAt,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    branch: row.branch,
    prUrl: row.prUrl,
    error: row.error,
  }
}
