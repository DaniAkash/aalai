import type { Database } from 'bun:sqlite'
import { MIGRATIONS, type Migration } from './migrations/journal'

const LEDGER = '__aalai_migrations'

/** Statements inside one generated migration are separated by this marker. */
const BREAKPOINT = '--> statement-breakpoint'

function ensureLedger(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  )
}

/**
 * Names already applied.
 *
 * Read only on purpose: the caller checks for pending work before taking the
 * backup, so creating the ledger here would put a table into the snapshot that
 * the database did not have when the attempt began.
 */
/** Whether this database has ever had a migration applied. */
function isMigrated(db: Database): boolean {
  const row = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${LEDGER}'`,
    )
    .get()
  return row !== null
}

function applied(db: Database): Set<string> {
  if (!isMigrated(db)) {
    return new Set()
  }
  const rows = db
    .query<{ name: string }, []>(`SELECT name FROM ${LEDGER}`)
    .all()
  return new Set(rows.map((row) => row.name))
}

/** Migrations this database has not applied yet, in order. */
export function pendingMigrations(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): Migration[] {
  const done = applied(db)
  return migrations.filter((migration) => !done.has(migration.name))
}

/**
 * Applies every migration the ledger has not seen, in order.
 *
 * Each migration runs inside a transaction so a statement failing halfway
 * cannot leave a partially created schema that the next start would read as
 * complete.
 *
 * @returns The names applied by this call.
 */
export function applyMigrations(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): string[] {
  ensureLedger(db)
  const done = applied(db)
  const fresh: string[] = []

  for (const migration of migrations) {
    if (done.has(migration.name)) {
      continue
    }
    const statements = migration.sql
      .split(BREAKPOINT)
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0)

    db.transaction(() => {
      for (const statement of statements) {
        db.exec(statement)
      }
      db.query(`INSERT INTO ${LEDGER} (name, applied_at) VALUES (?, ?)`).run(
        migration.name,
        new Date().toISOString(),
      )
    })()
    fresh.push(migration.name)
  }
  return fresh
}
