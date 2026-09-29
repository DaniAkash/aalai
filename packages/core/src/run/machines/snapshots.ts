import type { Database } from 'bun:sqlite'
import {
  type AnyStateMachine,
  createActor,
  type InputFrom,
  type Snapshot,
  type SnapshotFrom,
  waitFor,
} from 'xstate'
import { logger } from '@/lib/log'
import { query } from '@/modules/db/query'
import { machineSnapshots } from '@/modules/db/schema/schema'
import type { RunRef } from '@/modules/work/paths'
import { readJson, writeJson } from '@/modules/work/store'
import { releaseRunDeps } from './deps'
import { workState } from './types'

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

/**
 * Writes a run's state on every transition, in order.
 *
 * Chained rather than collected. Each transition overwrites the same row and the
 * same document, so letting them race means a later state can be overwritten by
 * an earlier one finishing second, and the snapshot then describes a run that
 * has already moved on.
 *
 * Returns the tail of the chain, so a caller that is about to stop can wait for
 * the last write rather than losing it.
 */
export function persistEveryTransition(input: {
  db: Database
  run: RunRef
  runId: string
  machine: string
  actor: {
    subscribe: (listener: (snapshot: { value: unknown }) => void) => unknown
    getPersistedSnapshot: () => unknown
  }
}): { settled: () => Promise<void> } {
  let writes: Promise<void> = Promise.resolve()
  input.actor.subscribe((snapshot) => {
    const value = workState(snapshot.value)
    const persisted = input.actor.getPersistedSnapshot()
    writes = writes.then(() =>
      persistSnapshot({
        db: input.db,
        run: input.run,
        runId: input.runId,
        machine: input.machine,
        value,
        snapshot: persisted,
      }),
    )
  })
  return { settled: () => writes }
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

/**
 * Starts a machine, persists every transition, waits for it to finish, and
 * always releases what it registered.
 *
 * Shared by both drivers, which had grown the same twenty three lines twice. A
 * run that persisted differently depending on which machine it was would be a
 * bad thing to find out about later.
 *
 * No timeout. A run parked on a gate or on a reporter can legitimately sit for
 * a fortnight, so a clock here would eventually kill a run for waiting exactly
 * as designed.
 */
export async function runMachine<TLogic extends AnyStateMachine>(input: {
  db: Database
  run: RunRef
  runId: string
  machine: string
  logic: TLogic
  machineInput: InputFrom<TLogic>
  snapshot?: unknown
  /** Cleanup the caller needs on the way out, whatever happened. */
  onSettled?: () => void
}): Promise<SnapshotFrom<TLogic>> {
  const actor = createActor(input.logic, {
    input: input.machineInput,
    ...(input.snapshot === undefined
      ? {}
      : { snapshot: input.snapshot as Snapshot<unknown> }),
  })
  const persisting = persistEveryTransition({
    db: input.db,
    run: input.run,
    runId: input.runId,
    machine: input.machine,
    actor,
  })
  try {
    actor.start()
    const settled = await waitFor(
      actor,
      (snapshot) => (snapshot as { status: string }).status === 'done',
      { timeout: Number.POSITIVE_INFINITY },
    )
    await persisting.settled()
    return settled as SnapshotFrom<TLogic>
  } finally {
    input.onSettled?.()
    actor.stop()
    releaseRunDeps(input.runId)
  }
}
