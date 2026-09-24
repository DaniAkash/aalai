import type { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import type { StationId } from '@/events/events.types'
import { query } from '@/modules/db/query'
import { type AttemptStatus, attempts } from '@/modules/db/schema/schema'
import type { RunRef } from '@/modules/work/paths'
import { readJson, writeJson } from '@/modules/work/store'

/**
 * One attempt at one station, and the idempotency key a restart needs.
 *
 * XState restores a snapshot but restarts invocations, so a station modelled
 * as a plain invoked promise would re-run a four minute agent turn on top of
 * work it already committed. The id is derived rather than random for exactly
 * that reason: the same station, on the same run, at the same revision, has to
 * name the same attempt after a restart as it did before one.
 */
export function attemptIdFor(
  runId: string,
  station: StationId,
  revision: number,
): string {
  return `${runId}:${station}:${revision}`
}

export interface AttemptRecord {
  readonly id: string
  readonly status: AttemptStatus
  readonly outcomePath: string | null
}

export function readAttempt(
  db: Database,
  id: string,
): AttemptRecord | undefined {
  return query(db)
    .select({
      id: attempts.id,
      status: attempts.status,
      outcomePath: attempts.outcomePath,
    })
    .from(attempts)
    .where(eq(attempts.id, id))
    .get()
}

export function beginAttempt(
  db: Database,
  input: { id: string; runId: string; station: StationId },
): void {
  const startedAt = new Date().toISOString()
  query(db)
    .insert(attempts)
    .values({
      id: input.id,
      runId: input.runId,
      station: input.station,
      status: 'started',
      startedAt,
    })
    .onConflictDoUpdate({
      target: attempts.id,
      set: { status: 'started', startedAt, finishedAt: null },
    })
    .run()
}

export function settleAttempt(
  db: Database,
  id: string,
  status: Exclude<AttemptStatus, 'started'>,
  outcomePath?: string,
): void {
  query(db)
    .update(attempts)
    .set({
      status,
      ...(outcomePath === undefined ? {} : { outcomePath }),
      finishedAt: new Date().toISOString(),
    })
    .where(eq(attempts.id, id))
    .run()
}

/** The outcome document an attempt produced, which is what a replay returns. */
export async function writeAttemptOutcome<T>(
  run: RunRef,
  id: string,
  outcome: T,
): Promise<string> {
  return await writeJson(run, join(id), outcome)
}

export async function readAttemptOutcome<T>(
  run: RunRef,
  id: string,
): Promise<T | undefined> {
  return await readJson<T>(run, join(id))
}

/** An attempt id contains a repository and a hash, neither of which is a filename. */
function join(id: string): string {
  return `attempts/${id.replace(/[^A-Za-z0-9._-]+/g, '-')}`
}
