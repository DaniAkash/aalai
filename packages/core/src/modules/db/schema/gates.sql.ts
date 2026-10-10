import { sql } from 'drizzle-orm'
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * `reclassify` is not `changes` under another name. `changes` means "plan this
 * again", and reclassify means "your classification is wrong", which carries a
 * value the machine reads rather than a instruction it follows.
 */
export const GATE_DECISIONS = [
  'approved',
  'rejected',
  'changes',
  'reclassify',
] as const
export type GateDecision = (typeof GATE_DECISIONS)[number]

/**
 * `trust` is the one that decides whether somebody else's code runs here.
 *
 * A separate kind rather than a `permission` gate, which is a question held open
 * inside a live agent turn and dies with it. This one is durable and can sit for
 * as long as it takes: nothing is waiting on it except a review that has already
 * said everything it can without running anything.
 */
/**
 * `review_reply` is the one that decides whether words reach a reviewer.
 *
 * Its own kind rather than a `permission`: the existing kinds each name what
 * is being decided, and "may this text go to a stranger" is not the same
 * question as "may this code run". One gate carries every answer to one
 * review, because the answers have to be read together: judging them one at a
 * time is how the seventh gets released without anybody noticing it
 * contradicts the third.
 */
export const GATE_KINDS = [
  'triage',
  'plan',
  'permission',
  'trust',
  'review_reply',
] as const
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
    /**
     * What the person is being asked to allow, in their words not the agent's.
     *
     * A plan gate points at an artifact a person can read. A permission ask has
     * no artifact, so without this the surfaces can only show a timestamp and
     * nobody can tell what they are approving.
     */
    summary: text('summary'),
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
