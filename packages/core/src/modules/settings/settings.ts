import type { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { logger } from '@/lib/log'
import { query } from '@/modules/db/query'
import { settings, watchedRepos } from '@/modules/db/schema/schema'
import {
  DOMAIN_NAMES,
  DOMAINS,
  type DomainName,
  type Domains,
  RUN_POLICIES,
  type RunPolicy,
} from './domains'

const log = logger('settings')

/**
 * One domain, or its defaults.
 *
 * A row that will not parse is replaced by defaults and logged rather than
 * thrown, because a single bad value should not be the reason a factory
 * refuses to start. The bad row is left alone so it can be looked at.
 */
export function readDomain<K extends DomainName>(
  db: Database,
  name: K,
): Domains[K] {
  const schemaFor = DOMAINS[name]
  const row = query(db)
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, name))
    .get()

  if (row === undefined) {
    return schemaFor.parse({}) as Domains[K]
  }
  try {
    const parsed = schemaFor.safeParse(JSON.parse(row.value))
    if (parsed.success) {
      return parsed.data as Domains[K]
    }
    log.warn('settings row did not validate, using defaults', {
      domain: name,
      problem: parsed.error.issues[0]?.message,
    })
  } catch {
    log.warn('settings row is not json, using defaults', { domain: name })
  }
  return schemaFor.parse({}) as Domains[K]
}

export function writeDomain<K extends DomainName>(
  db: Database,
  name: K,
  value: Domains[K],
): void {
  const parsed = DOMAINS[name].parse(value)
  const serialised = JSON.stringify(parsed)
  const updatedAt = new Date().toISOString()
  query(db)
    .insert(settings)
    .values({ key: name, value: serialised, updatedAt })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: serialised, updatedAt },
    })
    .run()
}

export function readAllDomains(db: Database): Domains {
  const out = {} as Domains
  for (const name of DOMAIN_NAMES) {
    // The index signature is lost by the loop, and narrowing it back per key
    // costs more than it explains.
    Object.assign(out, { [name]: readDomain(db, name) })
  }
  return out
}

export function writeAllDomains(db: Database, domains: Domains): void {
  for (const name of DOMAIN_NAMES) {
    writeDomain(db, name, domains[name])
  }
}

/** Whether anything has been stored yet, which is how a first start is spotted. */
export function settingsAreEmpty(db: Database): boolean {
  return (
    query(db).select({ key: settings.key }).from(settings).all().length === 0
  )
}

export interface WatchedRepoSetting {
  readonly repo: string
  readonly requireLabel?: string
  readonly policy?: RunPolicy
}

export function readWatchedRepos(db: Database): WatchedRepoSetting[] {
  return query(db)
    .select({
      repo: watchedRepos.repo,
      requireLabel: watchedRepos.requireLabel,
      policy: watchedRepos.policy,
    })
    .from(watchedRepos)
    .orderBy(watchedRepos.repo)
    .all()
    .map((row) => ({
      repo: row.repo,
      ...(row.requireLabel === null ? {} : { requireLabel: row.requireLabel }),
      ...(isPolicy(row.policy) ? { policy: row.policy } : {}),
    }))
}

/**
 * Replaces the watched set, which is how the picker's add and remove land.
 *
 * In one transaction, because a delete that commits before a failing insert
 * leaves the set erased. Duplicates are collapsed rather than allowed to be
 * that failing insert: the repository is the primary key, and a config file
 * written by hand can name one twice.
 */
export function writeWatchedRepos(
  db: Database,
  repos: readonly WatchedRepoSetting[],
): void {
  const unique = [...new Map(repos.map((repo) => [repo.repo, repo])).values()]
  db.transaction(() => {
    query(db).delete(watchedRepos).run()
    if (unique.length === 0) {
      return
    }
    query(db)
      .insert(watchedRepos)
      .values(
        unique.map((repo) => ({
          repo: repo.repo,
          requireLabel: repo.requireLabel ?? null,
          policy: repo.policy ?? null,
        })),
      )
      .run()
  })()
}

/**
 * Whether a stored policy is one this build understands.
 *
 * The column is free text, so a value written by a newer build is possible.
 * An unrecognised one falls back to the global default rather than reaching
 * the machine as a policy nothing handles.
 */
function isPolicy(value: string | null): value is RunPolicy {
  return value !== null && (RUN_POLICIES as readonly string[]).includes(value)
}
