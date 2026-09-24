import { sql } from 'drizzle-orm'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Where a run's state machine is, written on every transition from phase 2.
 *
 * `value` is the compact state so "which runs are waiting on me" is one query.
 * The full snapshot lives on disk at `snapshotPath`, because answering that
 * question must not mean parsing eight JSON documents.
 */
export const machineSnapshots = sqliteTable('machine_snapshots', {
  runId: text('run_id').primaryKey(),
  machine: text('machine').notNull(),
  snapshotPath: text('snapshot_path').notNull(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(sql`(current_timestamp)`),
})

export type MachineSnapshotRow = typeof machineSnapshots.$inferSelect
