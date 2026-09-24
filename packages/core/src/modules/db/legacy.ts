import type { Database } from 'bun:sqlite'

/**
 * Adopting the hand written schema that predates migrations.
 *
 * Before this phase the tables were created by `CREATE TABLE IF NOT EXISTS` at
 * every start, so an existing database has `runs` and `cursor` but no ledger,
 * and the initial migration's `CREATE TABLE` would collide with them. The rows
 * matter: `runs` is the claim table, and losing it means every issue already
 * handled looks unseen and gets a second pull request.
 *
 * So the old tables are moved aside, the migrations build the new schema, and
 * the rows are copied across with the issue number becoming a subject.
 */

const ASIDE = new Map([
  ['runs', 'runs_pre_migrations'],
  ['cursor', 'cursor_pre_migrations'],
])

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name)
  return row !== null
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
  return rows.some((row) => row.name === column)
}

/**
 * A pre-migration database is one with the old `runs` table, which is
 * recognisable by its `issue` column: the migrated shape calls that
 * `subject_number`.
 */
export function isPreMigrationSchema(db: Database): boolean {
  return tableExists(db, 'runs') && hasColumn(db, 'runs', 'issue')
}

/** Moves the old tables out of the way so the migrations can create theirs. */
export function setAsideLegacyTables(db: Database): void {
  for (const [from, to] of ASIDE) {
    if (tableExists(db, from) && !tableExists(db, to)) {
      db.exec(`ALTER TABLE ${from} RENAME TO ${to}`)
    }
  }
}

/**
 * Copies the set-aside rows into the migrated tables and drops the originals.
 *
 * `lease` is selected defensively because a database old enough to predate it
 * will not have the column, which is the same reason the ad hoc `ALTER TABLE`
 * existed in the first place.
 */
export function restoreLegacyRows(db: Database): void {
  if (tableExists(db, 'runs_pre_migrations')) {
    const lease = hasColumn(db, 'runs_pre_migrations', 'lease')
      ? 'lease'
      : 'NULL'
    db.exec(
      `INSERT OR IGNORE INTO runs
         (repo, subject_kind, subject_number, status, branch, pr_url, error, lease, started_at, finished_at)
       SELECT repo, 'issue', issue, status, branch, pr_url, error, ${lease}, started_at, finished_at
       FROM runs_pre_migrations`,
    )
    db.exec('DROP TABLE runs_pre_migrations')
  }
  if (tableExists(db, 'cursor_pre_migrations')) {
    db.exec(
      `INSERT OR IGNORE INTO cursor (repo, last_seen_at)
       SELECT repo, last_seen_at FROM cursor_pre_migrations`,
    )
    db.exec('DROP TABLE cursor_pre_migrations')
  }
}
