import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '@/config'

export type RunStatus = 'claimed' | 'delivered' | 'failed' | 'skipped'

export interface RunRecord {
  readonly repo: string
  readonly issue: number
  readonly status: RunStatus
  readonly branch: string | null
  readonly pr_url: string | null
  readonly error: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursor (
  repo TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  repo TEXT NOT NULL,
  issue INTEGER NOT NULL,
  status TEXT NOT NULL,
  branch TEXT,
  pr_url TEXT,
  error TEXT,
  lease TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (repo, issue)
);
`

export function openState(path?: string): Database {
  const file = path ?? join(stateDir(), 'aalai.sqlite')
  if (file !== ':memory:') {
    mkdirSync(stateDir(), { recursive: true })
  }
  const db = new Database(file, { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA)
  try {
    // Databases created before leases existed need the column added.
    db.exec('ALTER TABLE runs ADD COLUMN lease TEXT')
  } catch {
    // Already present.
  }
  return db
}

export function readCursor(db: Database, repo: string): string | null {
  const row = db
    .query<{ last_seen_at: string }, [string]>(
      'SELECT last_seen_at FROM cursor WHERE repo = ?',
    )
    .get(repo)
  return row?.last_seen_at ?? null
}

export function writeCursor(db: Database, repo: string, iso: string): void {
  db.query(
    `INSERT INTO cursor (repo, last_seen_at) VALUES (?, ?)
     ON CONFLICT(repo) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(repo, iso)
}

/**
 * Claims an issue for exactly one run, or takes over a claim that went stale.
 *
 * Polling has no delivery-once guarantee and a tick can overlap its predecessor,
 * so the primary key plus a conflict-guarded insert is what makes a duplicate
 * observation harmless. The staleness clause is the other half: a process killed
 * mid-run leaves a row stuck in `claimed`, and without a lease every later poll
 * would read that row as a completed duplicate and skip the issue forever.
 *
 * @returns True when this caller now owns the run.
 */
export function claimRun(
  db: Database,
  repo: string,
  issue: number,
  staleAfterMs = 30 * 60 * 1000,
): string | null {
  const now = new Date()
  const lease = crypto.randomUUID()
  const result = db
    .query(
      `INSERT INTO runs (repo, issue, status, lease, started_at)
     VALUES ($repo, $issue, 'claimed', $lease, $now)
     ON CONFLICT(repo, issue) DO UPDATE SET started_at = $now, lease = $lease, error = NULL
     WHERE runs.status = 'claimed' AND runs.started_at < $staleBefore`,
    )
    .run({
      $repo: repo,
      $issue: issue,
      $lease: lease,
      $now: now.toISOString(),
      $staleBefore: new Date(now.getTime() - staleAfterMs).toISOString(),
    })
  return result.changes > 0 ? lease : null
}

/**
 * Records a run's outcome.
 *
 * The lease is the fence. A run that outlives its lease can have its issue taken
 * over by a later pass, and without checking the token the original worker would
 * later overwrite the newer run's result, because `(repo, issue)` alone matches
 * both. A stale worker's write is dropped instead.
 *
 * @returns Whether the write was applied.
 */
export function completeRun(
  db: Database,
  repo: string,
  issue: number,
  outcome: {
    readonly status: Exclude<RunStatus, 'claimed'>
    readonly branch?: string
    readonly prUrl?: string
    readonly error?: string
    readonly lease?: string
  },
): boolean {
  const finishedAt = new Date().toISOString()
  const set = `UPDATE runs SET status = ?, branch = ?, pr_url = ?, error = ?, finished_at = ?`
  const values = [
    outcome.status,
    outcome.branch ?? null,
    outcome.prUrl ?? null,
    outcome.error ?? null,
    finishedAt,
    repo,
    issue,
  ] as const

  const result =
    outcome.lease === undefined
      ? db.query(`${set} WHERE repo = ? AND issue = ?`).run(...values)
      : db
          .query(`${set} WHERE repo = ? AND issue = ? AND lease = ?`)
          .run(...values, outcome.lease)
  return result.changes > 0
}

export function listRuns(db: Database, limit = 20): RunRecord[] {
  return db
    .query<RunRecord, [number]>(
      `SELECT repo, issue, status, branch, pr_url, error FROM runs
     ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit)
}

/** Removes a run record so the issue can be picked up again. The manual retry path. */
export function forgetRun(db: Database, repo: string, issue: number): boolean {
  const result = db
    .query('DELETE FROM runs WHERE repo = ? AND issue = ?')
    .run(repo, issue)
  return result.changes > 0
}
