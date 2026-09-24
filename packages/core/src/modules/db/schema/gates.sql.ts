import { sql } from 'drizzle-orm'
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const GATE_DECISIONS = ['approved', 'rejected', 'changes'] as const
export type GateDecision = (typeof GATE_DECISIONS)[number]

export const GATE_KINDS = ['plan', 'permission'] as const
export type GateKind = (typeof GATE_KINDS)[number]

/**
 * Open is waiting on a person. Superseded is the version moving underneath it.
 *
 * Without `superseded` the state has to be inferred from `answered_at` being
 * null, which cannot say "this stopped mattering because the plan was
 * rewritten" and so leaves a stale gate looking answerable forever.
 *
 * `expired` is the same problem for a permission ask: it holds a turn open and
 * dies with the process, so one nobody answered in time is not still waiting.
 */
export const GATE_STATUSES = [
  'open',
  'answered',
  'superseded',
  'expired',
] as const
export type GateStatus = (typeof GATE_STATUSES)[number]

/**
 * A point where a run stops and waits for a person.
 *
 * The artifact version is stored alongside the path because approval pins to
 * the bytes that were approved: a plan revised after the fact must not inherit
 * the approval given to its predecessor.
 */
export const gates = sqliteTable(
  'gates',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    kind: text('kind').$type<GateKind>().notNull(),
    status: text('status').$type<GateStatus>().notNull().default('open'),
    artifactPath: text('artifact_path'),
    artifactVersion: text('artifact_version'),
    openedAt: text('opened_at').notNull().default(sql`(current_timestamp)`),
    answeredAt: text('answered_at'),
    answeredBy: text('answered_by'),
    /** Where the answer arrived from: the desktop app, a comment, a reply. */
    answeredOn: text('answered_on'),
    decision: text('decision').$type<GateDecision>(),
    reason: text('reason'),
  },
  // "what is waiting on me" is the inbox's only question and it runs on every
  // poll of every client, so it reads an index rather than the whole table.
  (table) => [
    index('gates_status_opened_idx').on(table.status, table.openedAt),
    index('gates_run_idx').on(table.runId),
  ],
)

export type GateRow = typeof gates.$inferSelect
