import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** How far the poller has read into each repository's issue timeline. */
export const cursor = sqliteTable('cursor', {
  repo: text('repo').primaryKey(),
  lastSeenAt: text('last_seen_at').notNull(),
})

export type CursorRow = typeof cursor.$inferSelect
