import { and, eq } from 'drizzle-orm'
import type { RunStatus, SubjectKind } from '@/modules/db/schema/runs.sql'
import { runs } from '@/modules/db/schema/runs.sql'
import type { QueueEntry } from '@/modules/runs/queue.types'

/**
 * Reading a run row, and putting a list of them in a useful order.
 *
 * Separated from the queue's statements because these decide nothing: the
 * queue is the claims and the transitions, and this is how a row is read and
 * sorted once it has been.
 */

export function subjectOf(repo: string, kind: SubjectKind, number: number) {
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

export function byInterest(a: QueueEntry, b: QueueEntry): number {
  const rank = ORDER[a.status] - ORDER[b.status]
  if (rank !== 0) {
    return rank
  }
  return (a.queuedAt ?? a.offeredAt ?? a.startedAt).localeCompare(
    b.queuedAt ?? b.offeredAt ?? b.startedAt,
  )
}

export function toEntry(row: typeof runs.$inferSelect): QueueEntry {
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
    policy: row.policy,
  }
}
