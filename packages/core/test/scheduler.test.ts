import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '@/config'
import { openDb } from '@/modules/db/db'
import {
  blockRun,
  enqueueRun,
  offerRun,
  readRun,
  runningCount,
} from '@/modules/runs/queue'
import { promoteQueued } from '@/watch/scheduler'
import { completeRun } from '@/watch/state'

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

/**
 * Stands in for the pipeline, and deliberately takes time.
 *
 * The first version of this stub claimed synchronously and returned, which is
 * exactly what hid the bug it was supposed to catch: the scheduler awaited the
 * work, so a capacity of four still started one run per pass, and a stub that
 * finished instantly made that look correct.
 */
const startIt = async () => {
  await Bun.sleep(50)
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
    const result = promoteQueued(db, config(), startIt)
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
    promoteQueued(db, config({ maxParallelRuns: 4 }), startIt)
    expect(runningCount(db)).toBe(4)
  })

  test('promoting twice does not exceed the ceiling', async () => {
    // The pass runs on every tick, so running it again must be a no-op rather
    // than another two runs.
    queueMany(10)
    promoteQueued(db, config(), startIt)
    promoteQueued(db, config(), startIt)
    expect(runningCount(db)).toBe(2)
  })

  test('nothing queued starts nothing', async () => {
    const result = promoteQueued(db, config(), startIt)
    expect(result.started).toHaveLength(0)
  })

  test('a freed slot is taken by the next in line', async () => {
    queueMany(4)
    promoteQueued(db, config(), startIt)
    expect(runningCount(db)).toBe(2)
    completeRun(db, 'acme/app', 1, { status: 'delivered' })
    expect(runningCount(db)).toBe(1)
    const again = promoteQueued(db, config(), startIt)
    expect(again.started).toHaveLength(1)
    expect(runningCount(db)).toBe(2)
  })

  test('lowering the ceiling below what is running kills nothing', async () => {
    queueMany(6)
    promoteQueued(db, config({ maxParallelRuns: 4 }), startIt)
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
    promoteQueued(db, config(), startIt)
    expect(runningCount(db)).toBe(2)
    promoteQueued(db, config({ queuePaused: true }), startIt)
    expect(runningCount(db)).toBe(2)
  })

  test('resuming picks up where it left off, in order', async () => {
    queueMany(4)
    promoteQueued(db, config({ queuePaused: true }), startIt)
    const resumed = promoteQueued(db, config(), startIt)
    expect(resumed.started.map((e) => e.number)).toEqual([1, 2])
  })
})

describe('when starting goes wrong', () => {
  test('a throw from the work does not take the promotion down with it', async () => {
    // Synchronous, which is the dangerous shape: it escapes before there is a
    // promise to catch it on unless the call is wrapped.
    queueMany(3)
    expect(() =>
      promoteQueued(db, config(), () => {
        throw new Error('could not start')
      }),
    ).not.toThrow()
    await Bun.sleep(10)
  })

  test('the slot stays taken until the work settles its own row', async () => {
    // The contract moved with the atomic claim: by the time the work runs, the
    // row is already `running`. Releasing it is the work's job, which is why
    // startQueued settles on every path including a throw.
    queueMany(2)
    promoteQueued(db, config(), () => {
      throw new Error('no')
    })
    await Bun.sleep(10)
    expect(runningCount(db)).toBe(2)
  })
})

describe('a gate frees its slot for the next run', () => {
  test('the run behind a blocked one starts', async () => {
    // The whole reason `blocked` is a state. Without this, a plan gate left
    // open overnight holds a slot nothing is using.
    queueMany(3)
    promoteQueued(db, config(), startIt)
    expect(runningCount(db)).toBe(2)

    blockRun(db, 'acme/app', 'issue', 1)
    expect(runningCount(db)).toBe(1)

    const after = promoteQueued(db, config(), startIt)
    expect(after.started.map((e) => e.number)).toEqual([3])
    expect(runningCount(db)).toBe(2)
  })

  test('answering it puts it behind whatever is already waiting', async () => {
    queueMany(3)
    promoteQueued(db, config(), startIt)
    blockRun(db, 'acme/app', 'issue', 1)
    // Answered, so it rejoins the queue rather than jumping back into a slot.
    // The pause is the point rather than a flake guard: "goes to the back"
    // only means anything if its new position is later than what is already
    // waiting, and these timestamps are milliseconds.
    await Bun.sleep(5)
    enqueueRun(db, 'acme/app', 'issue', 1)
    expect(readRun(db, 'acme/app', 'issue', 1)?.status).toBe('queued')
    const after = promoteQueued(db, config(), startIt)
    // 3 was queued first and is still ahead of the one that just came back.
    expect(after.started.map((e) => e.number)).toEqual([3])
  })
})
