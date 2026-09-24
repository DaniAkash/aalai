import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/modules/db/db'
import {
  readStationSession,
  saveStationSession,
  sessionKeyFor,
} from '@/modules/sessions/sessions'

let dir: string
let db: ReturnType<typeof openDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-sessions-'))
  process.env.AALAI_STATE_DIR = dir
  db = openDb(join(dir, 'aalai.sqlite'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const RUN = 'acme/widgets#7@1758700000000'

describe('the session key', () => {
  test('names the station, because a persistent session fixes its prompt', () => {
    expect(sessionKeyFor(RUN, 'analyst')).not.toBe(
      sessionKeyFor(RUN, 'implementer'),
    )
  })

  test('names the run, so two issues cannot share a context', () => {
    expect(sessionKeyFor('acme/widgets#7@1', 'analyst')).not.toBe(
      sessionKeyFor('acme/widgets#8@1', 'analyst'),
    )
  })
})

describe('storing the acpx triple', () => {
  test('round trips', () => {
    saveStationSession(db.sqlite, RUN, 'analyst', {
      sessionKey: sessionKeyFor(RUN, 'analyst'),
      acpxSessionId: 'runtime-session-1',
      acpxRecordId: 'record-1',
      agentSessionId: 'agent-1',
    })

    expect(readStationSession(db.sqlite, RUN, 'analyst')).toEqual({
      sessionKey: sessionKeyFor(RUN, 'analyst'),
      acpxSessionId: 'runtime-session-1',
      acpxRecordId: 'record-1',
      agentSessionId: 'agent-1',
    })
  })

  test('a second turn updates the row rather than adding one', () => {
    const key = sessionKeyFor(RUN, 'implementer')
    saveStationSession(db.sqlite, RUN, 'implementer', {
      sessionKey: key,
      acpxSessionId: 'runtime-session-1',
      acpxRecordId: null,
      agentSessionId: null,
    })
    saveStationSession(db.sqlite, RUN, 'implementer', {
      sessionKey: key,
      acpxSessionId: 'runtime-session-1',
      acpxRecordId: 'record-2',
      agentSessionId: 'agent-2',
    })

    const rows = db.sqlite
      .query('SELECT * FROM station_sessions WHERE run_id = ?')
      .all(RUN)
    expect(rows.length).toBe(1)
    expect(
      readStationSession(db.sqlite, RUN, 'implementer')?.acpxRecordId,
    ).toBe('record-2')
  })

  test('stations of one run are stored apart', () => {
    for (const station of ['analyst', 'implementer', 'reviewer']) {
      saveStationSession(db.sqlite, RUN, station, {
        sessionKey: sessionKeyFor(RUN, station),
        acpxSessionId: `session-${station}`,
        acpxRecordId: null,
        agentSessionId: null,
      })
    }
    expect(readStationSession(db.sqlite, RUN, 'reviewer')?.acpxSessionId).toBe(
      'session-reviewer',
    )
    expect(readStationSession(db.sqlite, RUN, 'analyst')?.acpxSessionId).toBe(
      'session-analyst',
    )
  })

  test('a station that has never run reads as undefined', () => {
    expect(readStationSession(db.sqlite, RUN, 'analyst')).toBeUndefined()
  })
})
