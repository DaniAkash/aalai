import type { Database } from 'bun:sqlite'
import { logger } from '@/lib/log'
import { query } from '@/modules/db/query'
import { machineSnapshots } from '@/modules/db/schema/schema'
import type { RunRef } from '@/modules/work/paths'
import { readJson, writeJson } from '@/modules/work/store'

const log = logger('snapshot')

/**
 * Where a run is, written on every transition.
 *
 * The compact value goes in the row and the whole snapshot goes on disk,
 * because answering "which runs are waiting on me" must not mean parsing a
 * document per run. The row holds the pointer; the document holds the rest.
 */
export async function persistSnapshot(input: {
  db: Database
  run: RunRef
  runId: string
  machine: string
  value: string
  snapshot: unknown
}): Promise<void> {
  try {
    const path = await writeJson(input.run, 'machine', input.snapshot)
    const updatedAt = new Date().toISOString()
    query(input.db)
      .insert(machineSnapshots)
      .values({
        runId: input.runId,
        machine: input.machine,
        snapshotPath: path,
        value: input.value,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: machineSnapshots.runId,
        set: { value: input.value, snapshotPath: path, updatedAt },
      })
      .run()
  } catch (error) {
    // A snapshot is a hint and reality is authoritative, so failing to write
    // one must not fail the run it describes.
    log.warn('snapshot not persisted', {
      runId: input.runId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export interface ResumableRun {
  readonly runId: string
  readonly machine: string
  readonly value: string
  readonly snapshotPath: string
}

/**
 * Runs whose machine stopped somewhere other than an end state.
 *
 * `value` is the compact state in the row, which is the whole reason phase 1
 * stored it separately: asking what is unfinished must not mean opening a
 * document per run.
 */
export function unfinishedRuns(db: Database): ResumableRun[] {
  return query(db)
    .select({
      runId: machineSnapshots.runId,
      machine: machineSnapshots.machine,
      value: machineSnapshots.value,
      snapshotPath: machineSnapshots.snapshotPath,
    })
    .from(machineSnapshots)
    .all()
    .filter((row) => !FINAL.has(row.value))
}

/** States the machine does not come back from. */
const FINAL = new Set(['approved', 'finished'])

/** The persisted snapshot itself, or undefined if the document is gone. */
export async function readSnapshot(run: RunRef): Promise<unknown | undefined> {
  return await readJson<unknown>(run, 'machine')
}
