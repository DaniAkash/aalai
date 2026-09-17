import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
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
  return db
}

export function readCursor(db: Database, repo: string): string | null {
  const row = db.query<{ last_seen_at: string }, [string]>(
    'SELECT last_seen_at FROM cursor WHERE repo = ?',
  ).get(repo)
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
): boolean {
  const now = new Date()
  const result = db.query(
    `INSERT INTO runs (repo, issue, status, started_at)
     VALUES ($repo, $issue, 'claimed', $now)
     ON CONFLICT(repo, issue) DO UPDATE SET started_at = $now, error = NULL
     WHERE runs.status = 'claimed' AND runs.started_at < $staleBefore`,
  ).run({
    $repo: repo,
    $issue: issue,
    $now: now.toISOString(),
    $staleBefore: new Date(now.getTime() - staleAfterMs).toISOString(),
  })
  return result.changes > 0
}

export function completeRun(
  db: Database,
  repo: string,
  issue: number,
  outcome: {
    readonly status: Exclude<RunStatus, 'claimed'>
    readonly branch?: string
    readonly prUrl?: string
    readonly error?: string
  },
): void {
  db.query(
    `UPDATE runs SET status = ?, branch = ?, pr_url = ?, error = ?, finished_at = ?
     WHERE repo = ? AND issue = ?`,
  ).run(
    outcome.status,
    outcome.branch ?? null,
    outcome.prUrl ?? null,
    outcome.error ?? null,
    new Date().toISOString(),
    repo,
    issue,
  )
}

export function listRuns(db: Database, limit = 20): RunRecord[] {
  return db.query<RunRecord, [number]>(
    `SELECT repo, issue, status, branch, pr_url, error FROM runs
     ORDER BY started_at DESC LIMIT ?`,
  ).all(limit)
}

/** Removes a run record so the issue can be picked up again. The manual retry path. */
export function forgetRun(db: Database, repo: string, issue: number): boolean {
  const result = db.query('DELETE FROM runs WHERE repo = ? AND issue = ?').run(repo, issue)
  return result.changes > 0
}
