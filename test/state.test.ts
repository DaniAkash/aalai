import { describe, expect, test } from 'bun:test'
import { claimRun, completeRun, listRuns, openState, readCursor, writeCursor } from '@/watch/state'

describe('run claims', () => {
  test('a second claim for the same issue is refused', () => {
    const db = openState(':memory:')
    expect(claimRun(db, 'acme/widgets', 7)).toBe(true)
    expect(claimRun(db, 'acme/widgets', 7)).toBe(false)
    db.close()
  })

  test('different issues and repos claim independently', () => {
    const db = openState(':memory:')
    expect(claimRun(db, 'acme/widgets', 7)).toBe(true)
    expect(claimRun(db, 'acme/widgets', 8)).toBe(true)
    expect(claimRun(db, 'acme/other', 7)).toBe(true)
    db.close()
  })

  test('completing a run records its outcome', () => {
    const db = openState(':memory:')
    claimRun(db, 'acme/widgets', 7)
    completeRun(db, 'acme/widgets', 7, {
      status: 'delivered',
      branch: 'aalai/issue-7-fix',
      prUrl: 'https://github.com/acme/widgets/pull/9',
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
