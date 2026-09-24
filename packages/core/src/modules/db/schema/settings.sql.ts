import { sql } from 'drizzle-orm'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * One row per settings domain, the value a JSON blob a Zod schema owns.
 *
 * Adding a setting needs no migration, which matters because settings are the
 * thing that changes most and a migration per preference is how a schema ends
 * up with sixty columns nobody can name.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(sql`(current_timestamp)`),
})

export type SettingRow = typeof settings.$inferSelect
