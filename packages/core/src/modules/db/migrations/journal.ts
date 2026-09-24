import init from './0000_init_schema.sql' with { type: 'text' }

export interface Migration {
  readonly name: string
  readonly sql: string
}

/**
 * Migrations in application order, embedded rather than read from disk.
 *
 * drizzle-kit still generates the `.sql` files and they stay the source of
 * truth, but the core ships as a single compiled binary with no directory to
 * resolve against, so the contents are imported as text and travel inside it.
 * A new migration is appended here in the same commit that generates it.
 */
export const MIGRATIONS: readonly Migration[] = [
  { name: '0000_init_schema', sql: init },
]
