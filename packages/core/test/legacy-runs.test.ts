import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restoreLegacyRows } from '@/modules/db/legacy'

/**
 * Legacy rows are restored after the migrations have run, so the migration
 * that renames a status never sees them. A row carried back saying `claimed`
 * is a status nothing recognises: not counted as running, absent from the
 * queue, and free to be claimed a second time.
 */

let dir: string
let db: Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-legacy-'))
  db = new Database(join(dir, 'test.sqlite'), { create: true })
  db.exec(`CREATE TABLE runs (
    repo TEXT, subject_kind TEXT, subject_number INTEGER, status TEXT,
    branch TEXT, pr_url TEXT, error TEXT, lease TEXT, title TEXT,
    offered_at TEXT, queued_at TEXT, started_at TEXT, finished_at TEXT,
    PRIMARY KEY (repo, subject_kind, subject_number))`)
  db.exec(`CREATE TABLE runs_pre_migrations (
    repo TEXT, issue INTEGER, status TEXT, branch TEXT, pr_url TEXT,
    error TEXT, lease TEXT, started_at TEXT, finished_at TEXT)`)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const legacy = (status: string) =>
  db.exec(
    `INSERT INTO runs_pre_migrations (repo, issue, status, started_at)
     VALUES ('acme/app', 7, '${status}', '2026-01-01T00:00:00Z')`,
  )

const restored = () =>
  db.query<{ status: string }, []>('SELECT status FROM runs').get()?.status

describe('restoring rows from before the queue existed', () => {
  test('a claimed row comes back as running', () => {
    legacy('claimed')
    restoreLegacyRows(db)
    expect(restored()).toBe('running')
  })

  test('statuses that still mean something are left alone', () => {
    legacy('delivered')
    restoreLegacyRows(db)
    expect(restored()).toBe('delivered')
  })

  test('a failed row keeps saying failed', () => {
    legacy('failed')
    restoreLegacyRows(db)
    expect(restored()).toBe('failed')
  })

  test('the old table is dropped, so this cannot happen twice', () => {
    legacy('claimed')
    restoreLegacyRows(db)
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE name = 'runs_pre_migrations'",
      )
      .all()
    expect(tables).toHaveLength(0)
  })
})
