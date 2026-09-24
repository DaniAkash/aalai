import { sql } from 'drizzle-orm'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const ATTEMPT_STATUSES = [
  'started',
  'succeeded',
  'failed',
  'abandoned',
] as const
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number]

/**
 * One row per attempt at a station, and the idempotency key phase 2 needs: a
 * transition that is retried must be able to tell whether the work already
 * happened rather than doing it twice.
 */
export const attempts = sqliteTable('attempts', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  station: text('station').notNull(),
  status: text('status').$type<AttemptStatus>().notNull(),
  /** Path to the attempt's JSON under the run directory. Never its content. */
  outcomePath: text('outcome_path'),
  startedAt: text('started_at').notNull().default(sql`(current_timestamp)`),
  finishedAt: text('finished_at'),
})

export type AttemptRow = typeof attempts.$inferSelect
