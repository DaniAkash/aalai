import type { Database } from 'bun:sqlite'
import { logger } from '@/lib/log'
import { query } from '@/modules/db/query'
import { machineSnapshots } from '@/modules/db/schema/schema'
import type { RunRef } from '@/modules/work/paths'
import { writeJson } from '@/modules/work/store'

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
