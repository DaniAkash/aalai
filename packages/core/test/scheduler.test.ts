import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '@/config'
import { openDb } from '@/modules/db/db'
import { enqueueRun, offerRun, readRun, runningCount } from '@/watch/queue'
import { promoteQueued } from '@/watch/scheduler'
import { claimRun, completeRun } from '@/watch/state'

/**
 * The ceiling is the only thing between a queue of thirty and a laptop that
 * stops responding, so these tests are about the number never being exceeded,
 * under every way the count can change underneath it.
 */

let dir: string
let db: ReturnType<typeof openDb>['sqlite']

const config = (over: Partial<Config> = {}): Config =>
  ({
    maxParallelRuns: 2,
    queuePaused: false,
    staleClaimMinutes: 30,
    ...over,
  }) as Config

/** Stands in for the pipeline: claims the run, which is what makes it running. */
const startIt = (entry: { repo: string; number: number }) => {
  claimRun(db, entry.repo, entry.number)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-sched-'))
  process.env.AALAI_STATE_DIR = dir
  db = openDb(join(dir, 'test.sqlite')).sqlite
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function queueMany(n: number): void {
  for (let i = 1; i <= n; i++) {
    offerRun(db, { repo: 'acme/app', kind: 'issue', number: i })
    enqueueRun(db, 'acme/app', 'issue', i)
  }
}

describe('the ceiling', () => {
  test('ten queued and a ceiling of two starts exactly two', async () => {
    queueMany(10)
    const result = await promoteQueued(db, config(), startIt)
    expect(result.started).toHaveLength(2)
    expect(runningCount(db)).toBe(2)
  })

  test('a ceiling of one starts one, which is the safest setting', async () => {
    queueMany(5)
    await promoteQueued(db, config({ maxParallelRuns: 1 }), startIt)
    expect(runningCount(db)).toBe(1)
  })

  test('four is the ceiling and it is honoured', async () => {
    queueMany(10)
    await promoteQueued(db, config({ maxParallelRuns: 4 }), startIt)
    expect(runningCount(db)).toBe(4)
  })

  test('promoting twice does not exceed the ceiling', async () => {
    // The pass runs on every tick, so running it again must be a no-op rather
    // than another two runs.
    queueMany(10)
    await promoteQueued(db, config(), startIt)
    await promoteQueued(db, config(), startIt)
    expect(runningCount(db)).toBe(2)
  })

  test('nothing queued starts nothing', async () => {
    const result = await promoteQueued(db, config(), startIt)
    expect(result.started).toHaveLength(0)
  })

  test('a freed slot is taken by the next in line', async () => {
    queueMany(4)
    await promoteQueued(db, config(), startIt)
    expect(runningCount(db)).toBe(2)
    completeRun(db, 'acme/app', 1, { status: 'delivered' })
    expect(runningCount(db)).toBe(1)
    const again = await promoteQueued(db, config(), startIt)
    expect(again.started).toHaveLength(1)
    expect(runningCount(db)).toBe(2)
  })

  test('lowering the ceiling below what is running kills nothing', async () => {
    queueMany(6)
    await promoteQueued(db, config({ maxParallelRuns: 4 }), startIt)
    expect(runningCount(db)).toBe(4)
    // The running set drains on its own; promotion simply stops.
    const after = await promoteQueued(
      db,
      config({ maxParallelRuns: 1 }),
      startIt,
    )
    expect(after.started).toHaveLength(0)
    expect(runningCount(db)).toBe(4)
  })
})

describe('pausing', () => {
  test('stops promotion', async () => {
    queueMany(5)
    const result = await promoteQueued(
      db,
      config({ queuePaused: true }),
      startIt,
    )
    expect(result.paused).toBe(true)
    expect(result.started).toHaveLength(0)
    expect(runningCount(db)).toBe(0)
  })

  test('never kills what is already running', async () => {
    queueMany(5)
    await promoteQueued(db, config(), startIt)
    expect(runningCount(db)).toBe(2)
    await promoteQueued(db, config({ queuePaused: true }), startIt)
    expect(runningCount(db)).toBe(2)
  })

  test('resuming picks up where it left off, in order', async () => {
    queueMany(4)
    await promoteQueued(db, config({ queuePaused: true }), startIt)
    const resumed = await promoteQueued(db, config(), startIt)
    expect(resumed.started.map((e) => e.number)).toEqual([1, 2])
  })
})

describe('when starting goes wrong', () => {
  test('one unstartable run does not spin the loop forever', async () => {
    queueMany(3)
    let calls = 0
    const result = await promoteQueued(db, config(), () => {
      calls += 1
      throw new Error('could not start')
    })
    expect(calls).toBe(1)
    expect(result.started).toHaveLength(0)
    // Still queued, so the next pass can try it again.
    expect(readRun(db, 'acme/app', 'issue', 1)?.status).toBe('queued')
  })

  test('a start that fails does not consume a slot', async () => {
    queueMany(2)
    await promoteQueued(db, config(), () => {
      throw new Error('no')
    })
    expect(runningCount(db)).toBe(0)
  })
})
