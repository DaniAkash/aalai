import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core'
import type { RunPolicy } from '@/shared/modes'

/**
 * Where a run is, which is also where the work is allowed to be.
 *
 * `claimed` used to mean all of queued, running, waiting on a person, and
 * abandoned by a dead process at once. Those need different answers from the
 * scheduler, so they are different states.
 *
 * `offered` is the one that makes a laptop viable: the watcher may record that
 * something exists, and that costs one API call and nothing else. No claim, no
 * worktree, no agent, until a person asks for it.
 */
export const RUN_STATUSES = [
  'offered',
  'queued',
  'running',
  'blocked',
  'stopped',
  'delivered',
  'failed',
  'skipped',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** The states that consume one of the machine's slots. */
export const RUNNING_STATUSES: readonly RunStatus[] = ['running']

/**
 * States a run can leave on its own.
 *
 * `blocked` is deliberately absent: a gate can wait for days, so it releases
 * its slot and rejoins the queue when answered rather than holding one.
 */
export const ACTIVE_STATUSES: readonly RunStatus[] = ['queued', 'running']

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
    // What the issue or pull request is called. Stored because an offer has to
    // be legible in the inbox before anything has been fetched for it, and a
    // list that shows only numbers is a list nobody can triage.
    title: text('title'),
    // The mode a person chose for this one piece of work, which outranks the
    // repository's standing answer. Null is the repository's answer, which is
    // every run that predates the composer and every run the watcher starts.
    policy: text('policy').$type<RunPolicy>(),
    lease: text('lease'),
    // When the watcher first saw it, and when a person asked for it. The
    // second is what orders the queue, so first in really is first out.
    offeredAt: text('offered_at'),
    queuedAt: text('queued_at'),
    startedAt: text('started_at').notNull().default(sql`(current_timestamp)`),
    finishedAt: text('finished_at'),
  },
  (table) => [
    primaryKey({
      columns: [table.repo, table.subjectKind, table.subjectNumber],
    }),
    // The scheduler's only query: the oldest queued row. Without this it is a
    // table scan on every promotion, which happens on every tick.
    index('runs_status_queued_at').on(table.status, table.queuedAt),
  ],
)

export type RunRow = typeof runs.$inferSelect
