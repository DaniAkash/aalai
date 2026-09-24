import { sql } from 'drizzle-orm'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const GATE_DECISIONS = ['approved', 'rejected', 'changes'] as const
export type GateDecision = (typeof GATE_DECISIONS)[number]

/**
 * A point where a run stops and waits for a person, filled from phase 3.
 *
 * The artifact version is stored alongside the path because approval pins to
 * the bytes that were approved: a plan revised after the fact must not inherit
 * the approval given to its predecessor.
 */
export const gates = sqliteTable('gates', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  kind: text('kind').notNull(),
  artifactPath: text('artifact_path'),
  artifactVersion: text('artifact_version'),
  openedAt: text('opened_at').notNull().default(sql`(current_timestamp)`),
  answeredAt: text('answered_at'),
  answeredBy: text('answered_by'),
  /** Where the answer arrived from: the desktop app, a comment, a reply. */
  answeredOn: text('answered_on'),
  decision: text('decision').$type<GateDecision>(),
  reason: text('reason'),
})

export type GateRow = typeof gates.$inferSelect
