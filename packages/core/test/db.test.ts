import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateWithBackup, openDb } from '@/modules/db/db'
import { applyMigrations } from '@/modules/db/migrate'
import { MIGRATIONS } from '@/modules/db/migrations/journal'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-db-'))
  process.env.AALAI_STATE_DIR = dir
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name)
}

/** The schema as it was written by hand, before migrations existed. */
function buildPreMigrationDatabase(file: string): void {
  const db = new Database(file, { create: true })
  db.exec(`
    CREATE TABLE cursor (repo TEXT PRIMARY KEY, last_seen_at TEXT NOT NULL);
    CREATE TABLE runs (
      repo TEXT NOT NULL, issue INTEGER NOT NULL, status TEXT NOT NULL,
      branch TEXT, pr_url TEXT, error TEXT, lease TEXT,
      started_at TEXT NOT NULL, finished_at TEXT,
      PRIMARY KEY (repo, issue));`)
  db.query(
    `INSERT INTO runs (repo, issue, status, pr_url, started_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('acme/widgets', 7, 'delivered', 'https://example.test/pull/8', 'x')
  db.query('INSERT INTO cursor (repo, last_seen_at) VALUES (?, ?)').run(
    'acme/widgets',
    '2026-09-17T10:00:00Z',
  )
  db.close()
}

describe('migrations', () => {
  test('a fresh database gets every table', () => {
    const { sqlite } = openDb(join(dir, 'fresh.sqlite'))
    expect(tableNames(sqlite)).toEqual([
      '__aalai_migrations',
      'attempts',
      'cursor',
      'gates',
      'machine_snapshots',
      'runs',
      'settings',
      'station_sessions',
      'watched_repos',
    ])
  })

  test('applying twice is a no-op, so restarts are free', () => {
    const file = join(dir, 'twice.sqlite')
    openDb(file).sqlite.close()
    const { sqlite } = openDb(file)
    expect(applyMigrations(sqlite)).toEqual([])
  })
})

describe('adopting the pre-migration schema', () => {
  test('claims survive, so a handled issue is not handled twice', () => {
    const file = join(dir, 'legacy.sqlite')
    buildPreMigrationDatabase(file)

    const { sqlite } = openDb(file)
    const run = sqlite
      .query<
        { subject_kind: string; subject_number: number; pr_url: string },
        []
      >('SELECT subject_kind, subject_number, pr_url FROM runs')
      .get()

    expect(run).toEqual({
      subject_kind: 'issue',
      subject_number: 7,
      pr_url: 'https://example.test/pull/8',
    })
  })

  test('the poll cursor survives, so the archive is not replayed', () => {
    const file = join(dir, 'legacy-cursor.sqlite')
    buildPreMigrationDatabase(file)
    const { sqlite } = openDb(file)
    const row = sqlite
      .query<{ last_seen_at: string }, []>('SELECT last_seen_at FROM cursor')
      .get()
    expect(row?.last_seen_at).toBe('2026-09-17T10:00:00Z')
  })

  test('the old tables are gone once their rows are carried over', () => {
    const file = join(dir, 'legacy-drop.sqlite')
    buildPreMigrationDatabase(file)
    const { sqlite } = openDb(file)
    expect(
      tableNames(sqlite).filter((n) => n.endsWith('_pre_migrations')),
    ).toEqual([])
  })
})

describe('a migration that fails', () => {
  test('restores the backup rather than leaving half a schema', () => {
    const file = join(dir, 'broken.sqlite')
    buildPreMigrationDatabase(file)

    const broken = [
      ...MIGRATIONS,
      { name: '9999_broken', sql: 'CREATE TABLE ( this is not sql' },
    ]
    const sqlite = new Database(file, { create: true })
    expect(() => migrateWithBackup(sqlite, file, broken)).toThrow()

    // The file on disk is the one from before the attempt: still the old
    // schema, still holding its rows, and with no ledger claiming otherwise.
    const reopened = new Database(file)
    expect(tableNames(reopened)).toEqual(['cursor', 'runs'])
    const row = reopened
      .query<{ issue: number }, []>('SELECT issue FROM runs')
      .get()
    expect(row?.issue).toBe(7)
  })
})
