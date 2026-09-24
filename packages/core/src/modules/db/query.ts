import type { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import type { Db } from './db'
import * as schema from './schema/schema'

/**
 * The drizzle view of a connection, built once per connection.
 *
 * Modules take the raw `Database` so callers can keep threading one explicitly,
 * which is what makes the tests able to hand each case its own. Rebuilding the
 * wrapper on every query would be wasteful and, more to the point, would put
 * the same three lines in every module that touches a table.
 *
 * Keyed weakly so a closed connection is not held alive by this cache.
 */
const built = new WeakMap<Database, Db>()

export function query(db: Database): Db {
  const existing = built.get(db)
  if (existing !== undefined) {
    return existing
  }
  const fresh = drizzle(db, { schema })
  built.set(db, fresh)
  return fresh
}
