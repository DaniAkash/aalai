import { sql } from 'drizzle-orm'
import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * The three ids acpx needs to resume a conversation, one row per station per
 * run. aalai stores the reference; acpx keeps the session itself under its own
 * state directory.
 */
export const stationSessions = sqliteTable(
  'station_sessions',
  {
    runId: text('run_id').notNull(),
    station: text('station').notNull(),
    /** `${runId}:${station}`. The station is in the key because a persistent
     * session fixes its system prompt at creation, so sharing one key across
     * stations would leak the analyst's prompt into the implementer's turn. */
    sessionKey: text('session_key').notNull(),
    acpxSessionId: text('acpx_session_id'),
    acpxRecordId: text('acpx_record_id'),
    agentSessionId: text('agent_session_id'),
    updatedAt: text('updated_at').notNull().default(sql`(current_timestamp)`),
  },
  (table) => [primaryKey({ columns: [table.runId, table.station] })],
)

export type StationSessionRow = typeof stationSessions.$inferSelect
