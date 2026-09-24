import { sql } from 'drizzle-orm'
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const RUN_STATUSES = [
  'claimed',
  'delivered',
  'failed',
  'skipped',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/**
 * What a run is about.
 *
 * A pull request opened by a stranger is reviewed, discussed and decided the
 * same way an issue is, so it claims the same way rather than through a
 * parallel table that would have to be kept in step.
 */
export const SUBJECT_KINDS = ['issue', 'pr'] as const
export type SubjectKind = (typeof SUBJECT_KINDS)[number]

/**
 * The claim table. The primary key is what makes a duplicate observation
 * harmless, and the lease is what stops a killed process claiming forever.
 */
export const runs = sqliteTable(
  'runs',
  {
    repo: text('repo').notNull(),
    subjectKind: text('subject_kind').$type<SubjectKind>().notNull(),
    subjectNumber: integer('subject_number').notNull(),
    status: text('status').$type<RunStatus>().notNull(),
    branch: text('branch'),
    prUrl: text('pr_url'),
    error: text('error'),
    lease: text('lease'),
    startedAt: text('started_at').notNull().default(sql`(current_timestamp)`),
    finishedAt: text('finished_at'),
  },
  (table) => [
    primaryKey({
      columns: [table.repo, table.subjectKind, table.subjectNumber],
    }),
  ],
)

export type RunRow = typeof runs.$inferSelect
