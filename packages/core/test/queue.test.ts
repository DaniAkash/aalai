import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/modules/db/db'
import {
  blockRun,
  dismissRun,
  enqueueRun,
  listQueue,
  liveQueue,
  nextQueued,
  offerRun,
  readRun,
  runningCount,
} from '@/watch/queue'
import { claimRun, completeRun } from '@/watch/state'

/**
 * The queue exists because the factory runs on a laptop. Every test here is
 * about a promise that keeps a laptop usable: discovery starts nothing, the
 * order is the order a person asked for, and a run waiting on a person does
 * not hold a slot.
 */

let dir: string
let db: ReturnType<typeof openDb>['sqlite']

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-queue-'))
  process.env.AALAI_STATE_DIR = dir
  db = openDb(join(dir, 'test.sqlite')).sqlite
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const offer = (repo: string, n: number, title = 'something') =>
  offerRun(db, { repo, kind: 'issue', number: n, title })

describe('an offer costs nothing', () => {
  test('recording one does not claim it', () => {
    offer('acme/app', 1)
    const row = readRun(db, 'acme/app', 'issue', 1)
    expect(row?.status).toBe('offered')
    // The lease is what a claim is. An offer has none, which is what makes it
    // safe to record thirty of them at once.
    expect(row?.queuedAt).toBeNull()
    expect(runningCount(db)).toBe(0)
  })

  test('thirty offers start nothing at all', () => {
    // The number that caused this feature: one real repository with thirty
    // open pull requests used to mean thirty concurrent runs.
    for (let i = 1; i <= 30; i++) {
      offerRun(db, { repo: 'acme/app', kind: 'pr', number: i })
    }
    expect(listQueue(db, 'offered')).toHaveLength(30)
    expect(runningCount(db)).toBe(0)
    expect(nextQueued(db)).toBeUndefined()
  })

  test('seeing the same thing twice is harmless', () => {
    expect(offer('acme/app', 1)).toBe(true)
    expect(offer('acme/app', 1)).toBe(false)
    expect(listQueue(db, 'offered')).toHaveLength(1)
  })

  test('an offer never overwrites a run that already started', () => {
    offer('acme/app', 1)
    enqueueRun(db, 'acme/app', 'issue', 1)
    claimRun(db, 'acme/app', 1)
    offer('acme/app', 1)
    expect(readRun(db, 'acme/app', 'issue', 1)?.status).toBe('running')
  })

  test('the title is kept, because an offer has to be legible before anything is fetched', () => {
    offer('acme/app', 4, 'Reversed bounds silently return the max')
    expect(readRun(db, 'acme/app', 'issue', 4)?.title).toBe(
      'Reversed bounds silently return the max',
    )
  })
})

describe('the queue is ordered by when a person asked', () => {
  test('first in, first out', async () => {
    offer('acme/app', 1)
    offer('acme/app', 2)
    // Queued in the opposite order to the one they were offered in, which is
    // the case that tells the two timestamps apart.
    enqueueRun(db, 'acme/app', 'issue', 2)
    await Bun.sleep(5)
    enqueueRun(db, 'acme/app', 'issue', 1)
    expect(nextQueued(db)?.number).toBe(2)
  })

  test('queueing stamps the time, offering does not', () => {
    offer('acme/app', 1)
    expect(readRun(db, 'acme/app', 'issue', 1)?.queuedAt).toBeNull()
    enqueueRun(db, 'acme/app', 'issue', 1)
    expect(readRun(db, 'acme/app', 'issue', 1)?.queuedAt).not.toBeNull()
  })

  test('a run already running is not re-queued behind itself', () => {
    offer('acme/app', 1)
    enqueueRun(db, 'acme/app', 'issue', 1)
    claimRun(db, 'acme/app', 1)
    expect(enqueueRun(db, 'acme/app', 'issue', 1)).toBe(false)
    expect(readRun(db, 'acme/app', 'issue', 1)?.status).toBe('running')
  })

  test('a failed run can be queued again, which is what try again means', () => {
    offer('acme/app', 1)
    enqueueRun(db, 'acme/app', 'issue', 1)
    claimRun(db, 'acme/app', 1)
    completeRun(db, 'acme/app', 1, {
      status: 'failed',
      error: 'no test command',
    })
    expect(enqueueRun(db, 'acme/app', 'issue', 1)).toBe(true)
    expect(readRun(db, 'acme/app', 'issue', 1)?.status).toBe('queued')
    // The old error does not survive into the new attempt.
    expect(readRun(db, 'acme/app', 'issue', 1)?.error).toBeNull()
  })

  test('a stopped run can be queued again', () => {
    offer('acme/app', 1)
    enqueueRun(db, 'acme/app', 'issue', 1)
    claimRun(db, 'acme/app', 1)
    completeRun(db, 'acme/app', 1, { status: 'stopped' })
    expect(enqueueRun(db, 'acme/app', 'issue', 1)).toBe(true)
  })
})

describe('dismissing', () => {
  test('an offer the person declined does not come back', () => {
    offer('acme/app', 1)
    expect(dismissRun(db, 'acme/app', 'issue', 1)).toBe(true)
    // Re-offering is what the next poll does, and it must not resurrect it.
    expect(offer('acme/app', 1)).toBe(false)
    expect(readRun(db, 'acme/app', 'issue', 1)?.status).toBe('skipped')
  })

  test('a queued run can be taken back out of the queue', () => {
    offer('acme/app', 1)
    enqueueRun(db, 'acme/app', 'issue', 1)
    expect(dismissRun(db, 'acme/app', 'issue', 1)).toBe(true)
    expect(nextQueued(db)).toBeUndefined()
  })

  test('a running run cannot be dismissed out from under itself', () => {
    offer('acme/app', 1)
    enqueueRun(db, 'acme/app', 'issue', 1)
    claimRun(db, 'acme/app', 1)
    expect(dismissRun(db, 'acme/app', 'issue', 1)).toBe(false)
    expect(readRun(db, 'acme/app', 'issue', 1)?.status).toBe('running')
  })
})

describe('a gate holds no slot', () => {
  test('blocking releases the slot', () => {
    offer('acme/app', 1)
    enqueueRun(db, 'acme/app', 'issue', 1)
    claimRun(db, 'acme/app', 1)
    expect(runningCount(db)).toBe(1)
    expect(blockRun(db, 'acme/app', 'issue', 1)).toBe(true)
    expect(runningCount(db)).toBe(0)
  })

  test('three unanswered gates leave three slots free, not zero', () => {
    // The deadlock this state exists to prevent.
    for (const n of [1, 2, 3]) {
      offer('acme/app', n)
      enqueueRun(db, 'acme/app', 'issue', n)
      claimRun(db, 'acme/app', n)
      blockRun(db, 'acme/app', 'issue', n)
    }
    expect(runningCount(db)).toBe(0)
    expect(listQueue(db, 'blocked')).toHaveLength(3)
  })

  test('answering puts it back in the queue rather than straight into a slot', () => {
    offer('acme/app', 1)
    enqueueRun(db, 'acme/app', 'issue', 1)
    claimRun(db, 'acme/app', 1)
    blockRun(db, 'acme/app', 'issue', 1)
    expect(enqueueRun(db, 'acme/app', 'issue', 1)).toBe(true)
    expect(readRun(db, 'acme/app', 'issue', 1)?.status).toBe('queued')
    expect(runningCount(db)).toBe(0)
  })

  test('blocking only applies to something that is actually running', () => {
    offer('acme/app', 1)
    expect(blockRun(db, 'acme/app', 'issue', 1)).toBe(false)
  })
})

describe('what the interface reads', () => {
  test('live work excludes what is finished', () => {
    offer('acme/app', 1)
    offer('acme/app', 2)
    enqueueRun(db, 'acme/app', 'issue', 2)
    claimRun(db, 'acme/app', 2)
    completeRun(db, 'acme/app', 2, { status: 'delivered' })
    expect(liveQueue(db).map((e) => e.number)).toEqual([1])
  })

  test('what needs a person sorts above what is merely moving', () => {
    offer('acme/app', 1)
    offer('acme/app', 2)
    enqueueRun(db, 'acme/app', 'issue', 2)
    claimRun(db, 'acme/app', 2)
    offer('acme/app', 3)
    enqueueRun(db, 'acme/app', 'issue', 3)
    claimRun(db, 'acme/app', 3)
    blockRun(db, 'acme/app', 'issue', 3)
    expect(liveQueue(db).map((e) => e.status)).toEqual([
      'blocked',
      'running',
      'offered',
    ])
  })

  test('pull requests and issues share the table without colliding', () => {
    offerRun(db, { repo: 'acme/app', kind: 'issue', number: 7 })
    offerRun(db, { repo: 'acme/app', kind: 'pr', number: 7 })
    expect(listQueue(db, 'offered')).toHaveLength(2)
    expect(readRun(db, 'acme/app', 'pr', 7)?.kind).toBe('pr')
  })
})
