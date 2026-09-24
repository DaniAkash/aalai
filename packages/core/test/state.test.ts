import type { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import {
  claimRun,
  completeRun,
  forgetRun,
  listRuns,
  openState,
  readCursor,
  writeCursor,
} from '@/watch/state'

describe('run claims', () => {
  test('a second claim for the same issue is refused', () => {
    const db = openState(':memory:')
    expect(claimRun(db, 'acme/widgets', 7)).not.toBeNull()
    expect(claimRun(db, 'acme/widgets', 7)).toBeNull()
    db.close()
  })

  test('different issues and repos claim independently', () => {
    const db = openState(':memory:')
    expect(claimRun(db, 'acme/widgets', 7)).not.toBeNull()
    expect(claimRun(db, 'acme/widgets', 8)).not.toBeNull()
    expect(claimRun(db, 'acme/other', 7)).not.toBeNull()
    db.close()
  })

  test('completing a run records its outcome', () => {
    const db = openState(':memory:')
    const lease = claimRun(db, 'acme/widgets', 8)
    completeRun(db, 'acme/widgets', 8, {
      status: 'delivered',
      branch: 'aalai/issue-8-fix',
      prUrl: 'https://github.com/acme/widgets/pull/9',
      lease: lease ?? undefined,
    })
    const [run] = listRuns(db)
    expect(run?.status).toBe('delivered')
    expect(run?.pr_url).toBe('https://github.com/acme/widgets/pull/9')
    db.close()
  })
})

describe('cursor', () => {
  test('round-trips and overwrites per repo', () => {
    const db = openState(':memory:')
    expect(readCursor(db, 'acme/widgets')).toBeNull()
    writeCursor(db, 'acme/widgets', '2026-09-17T10:00:00Z')
    expect(readCursor(db, 'acme/widgets')).toBe('2026-09-17T10:00:00Z')
    writeCursor(db, 'acme/widgets', '2026-09-17T11:00:00Z')
    expect(readCursor(db, 'acme/widgets')).toBe('2026-09-17T11:00:00Z')
    db.close()
  })
})

/** Rewinds a run's start time, standing in for wall-clock time the test cannot wait out. */
function backdateClaim(
  db: Database,
  repo: string,
  issue: number,
  minutesAgo: number,
): void {
  db.query('UPDATE runs SET started_at = ? WHERE repo = ? AND issue = ?').run(
    new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    repo,
    issue,
  )
}

describe('stale claims', () => {
  test('a fresh claim cannot be taken over', () => {
    const db = openState(':memory:')
    expect(claimRun(db, 'acme/widgets', 7)).not.toBeNull()
    expect(claimRun(db, 'acme/widgets', 7, 30 * 60 * 1000)).toBeNull()
    db.close()
  })

  test('a claim older than the lease is taken over, so a killed run is not lost forever', () => {
    const db = openState(':memory:')
    expect(claimRun(db, 'acme/widgets', 7)).not.toBeNull()
    // Simulate a run that was killed 40 minutes ago and never finished.
    backdateClaim(db, 'acme/widgets', 7, 40)
    expect(claimRun(db, 'acme/widgets', 7, 30 * 60 * 1000)).not.toBeNull()
    db.close()
  })

  test('a claim still inside the lease is left alone', () => {
    const db = openState(':memory:')
    claimRun(db, 'acme/widgets', 7)
    backdateClaim(db, 'acme/widgets', 7, 5)
    expect(claimRun(db, 'acme/widgets', 7, 30 * 60 * 1000)).toBeNull()
    db.close()
  })

  test('a finished run is never reclaimed, however old it is', () => {
    const db = openState(':memory:')
    claimRun(db, 'acme/widgets', 7)
    completeRun(db, 'acme/widgets', 7, {
      status: 'delivered',
      prUrl: 'https://example/pull/9',
    })
    backdateClaim(db, 'acme/widgets', 7, 24 * 60)
    expect(claimRun(db, 'acme/widgets', 7, 30 * 60 * 1000)).toBeNull()
    db.close()
  })

  test('forgetting a run makes it claimable again', () => {
    const db = openState(':memory:')
    claimRun(db, 'acme/widgets', 7)
    completeRun(db, 'acme/widgets', 7, { status: 'failed', error: 'boom' })
    expect(claimRun(db, 'acme/widgets', 7)).toBeNull()
    expect(forgetRun(db, 'acme/widgets', 7)).toBe(true)
    expect(claimRun(db, 'acme/widgets', 7)).not.toBeNull()
    db.close()
  })
})

describe('lease fencing', () => {
  test('a worker whose claim was taken over cannot overwrite the new result', () => {
    const db = openState(':memory:')
    const first = claimRun(db, 'acme/widgets', 7)
    expect(first).not.toBeNull()

    // The first run overruns its lease and a later pass takes the issue over.
    backdateClaim(db, 'acme/widgets', 7, 40)
    const second = claimRun(db, 'acme/widgets', 7, 30 * 60 * 1000)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)

    // The new owner records its result, then the stale worker tries to.
    expect(
      completeRun(db, 'acme/widgets', 7, {
        status: 'delivered',
        prUrl: 'https://example/pull/new',
        lease: second ?? undefined,
      }),
    ).toBe(true)
    expect(
      completeRun(db, 'acme/widgets', 7, {
        status: 'failed',
        error: 'stale worker',
        lease: first ?? undefined,
      }),
    ).toBe(false)

    const [run] = listRuns(db)
    expect(run?.status).toBe('delivered')
    expect(run?.pr_url).toBe('https://example/pull/new')
    db.close()
  })
})
