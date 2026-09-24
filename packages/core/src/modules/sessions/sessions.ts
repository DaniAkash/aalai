import type { Database } from 'bun:sqlite'
import type { createAcpxProvider } from 'acpx-ai-provider'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { logger } from '@/lib/log'
import * as schema from '@/modules/db/schema/schema'
import { stationSessions } from '@/modules/db/schema/schema'

const log = logger('sessions')

/** The provider this module records ids from. */
export type Provider = ReturnType<typeof createAcpxProvider>

/**
 * The three ids acpx needs to pick a conversation back up.
 *
 * aalai stores the reference and nothing else. acpx keeps the session itself
 * under its own state directory, because owning another tool's layout means
 * inheriting it as a compatibility burden forever.
 */
export interface StationSession {
  readonly sessionKey: string
  readonly acpxSessionId: string | null
  readonly acpxRecordId: string | null
  readonly agentSessionId: string | null
}

function query(db: Database) {
  return drizzle(db, { schema })
}

/**
 * The session key must name the station.
 *
 * A persistent session fixes its system prompt when it is created, and acpx
 * ignores a different one on reuse. Every station runs in the same worktree
 * with a different prompt, so one key per run would leak the analyst's prompt
 * into the implementer's turn. The run is in the key too, so two issues being
 * worked at once cannot share a context.
 */
export function sessionKeyFor(runId: string, station: string): string {
  return `${runId}:${station}`
}

export function readStationSession(
  db: Database,
  runId: string,
  station: string,
): StationSession | undefined {
  return query(db)
    .select({
      sessionKey: stationSessions.sessionKey,
      acpxSessionId: stationSessions.acpxSessionId,
      acpxRecordId: stationSessions.acpxRecordId,
      agentSessionId: stationSessions.agentSessionId,
    })
    .from(stationSessions)
    .where(
      and(
        eq(stationSessions.runId, runId),
        eq(stationSessions.station, station),
      ),
    )
    .get()
}

export function saveStationSession(
  db: Database,
  runId: string,
  station: string,
  session: StationSession,
): void {
  const updatedAt = new Date().toISOString()
  query(db)
    .insert(stationSessions)
    .values({ runId, station, ...session, updatedAt })
    .onConflictDoUpdate({
      target: [stationSessions.runId, stationSessions.station],
      set: { ...session, updatedAt },
    })
    .run()
}

/**
 * Records where a station's conversation got to, best effort.
 *
 * Swallowed on purpose: if the handle is not ready there is nothing worth
 * recording, and the next turn will try again. A failure to note a session id
 * must never fail a run that otherwise succeeded.
 */
export async function rememberSession(
  db: Database,
  provider: Provider,
  runId: string,
  station: string,
): Promise<void> {
  try {
    const { handle, sessionKey } = await provider.ensureHandle()
    const status = await provider.runtime.getStatus?.({ handle })
    saveStationSession(db, runId, station, {
      sessionKey,
      acpxSessionId: handle.runtimeSessionName ?? null,
      acpxRecordId: status?.acpxRecordId ?? handle.acpxRecordId ?? null,
      agentSessionId: status?.agentSessionId ?? handle.agentSessionId ?? null,
    })
  } catch (error) {
    log.debug('session ids not recorded', {
      runId,
      station,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
