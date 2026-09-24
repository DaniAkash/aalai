import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** What the repository picker writes. */
export const watchedRepos = sqliteTable('watched_repos', {
  /** `owner/repo`, in GitHub's canonical casing. */
  repo: text('repo').primaryKey(),
  /** Per repository label gate, overriding the global default when set. */
  requireLabel: text('require_label'),
  /** Reserved for the trust policy phase 3 attaches to a repository. */
  policy: text('policy'),
  /** Paused stops new runs. Muted keeps running but stops notifying. */
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  muted: integer('muted', { mode: 'boolean' }).notNull().default(false),
  addedAt: text('added_at').notNull().default(sql`(current_timestamp)`),
})

export type WatchedRepoRow = typeof watchedRepos.$inferSelect
