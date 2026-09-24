import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { stateDir } from '@/config'
import { logger } from '@/lib/log'
import {
  isPreMigrationSchema,
  restoreLegacyRows,
  setAsideLegacyTables,
} from './legacy'
import { applyMigrations, pendingMigrations } from './migrate'
import { MIGRATIONS, type Migration } from './migrations/journal'
import * as schema from './schema/schema'

const log = logger('db')

export type Db = ReturnType<typeof drizzle<typeof schema>>

export interface DbHandle {
  /** The underlying connection, for pragmas and the migration path. */
  readonly sqlite: Database
  readonly db: Db
}

function databasePath(): string {
  return join(stateDir(), 'aalai.sqlite')
}

/**
 * A consistent copy, taken with VACUUM INTO rather than a file copy.
 *
 * WAL mode keeps recent commits in a sidecar file, so copying only the main
 * database can produce a backup that is missing the newest writes.
 */
function backup(sqlite: Database, to: string): void {
  rmSync(to, { force: true })
  sqlite.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`)
}

/**
 * Migrates behind a backup, restoring it if anything throws.
 *
 * `migrations` is injectable so the restore path can be exercised with a
 * deliberately broken migration, which is the only way to know the recovery
 * works before the day it is needed.
 */
export function migrateWithBackup(
  sqlite: Database,
  file: string,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  const legacy = isPreMigrationSchema(sqlite)
  if (pendingMigrations(sqlite, migrations).length === 0 && !legacy) {
    return
  }

  const backupPath = `${file}.backup`
  const recoverable = file !== ':memory:'
  if (recoverable) {
    backup(sqlite, backupPath)
  }

  try {
    if (legacy) {
      setAsideLegacyTables(sqlite)
    }
    const applied = applyMigrations(sqlite, migrations)
    if (legacy) {
      restoreLegacyRows(sqlite)
    }
    if (applied.length > 0) {
      log.info('migrations applied', { migrations: applied.join(',') })
    }
    if (recoverable) {
      rmSync(backupPath, { force: true })
    }
  } catch (error) {
    // A half migrated database is worse than a failed start, because the next
    // start finds schema no code expects. The backup goes back and the error
    // is rethrown so the failure is loud rather than silently degraded.
    if (recoverable && existsSync(backupPath)) {
      sqlite.close()
      copyFileSync(backupPath, file)
      rmSync(backupPath, { force: true })
      log.error('migration failed, database restored from backup', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  }
}

/** Opens a database, applies any pending migrations, and returns both views of it. */
export function openDb(path?: string): DbHandle {
  const file = path ?? databasePath()
  if (file !== ':memory:') {
    mkdirSync(stateDir(), { recursive: true })
  }
  const sqlite = new Database(file, { create: true })
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  migrateWithBackup(sqlite, file)
  return { sqlite, db: drizzle(sqlite, { schema }) }
}
