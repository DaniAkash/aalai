import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, setDb } from '@/modules/db/db'
import { writeDomain } from '@/modules/settings/settings'
import { app } from '@/server/app'
import { enqueueRun, offerRun, readRun } from '@/watch/queue'
import { claimRun } from '@/watch/state'

/**
 * Every route in this file is a person acting, which is the property the queue
 * exists to create: nothing here is reachable from a poll. These go through the
 * real Hono app against a real database rather than re-declaring the schemas,
 * because what matters is the status code a button will actually receive.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-qroute-'))
  process.env.AALAI_STATE_DIR = dir
  // The process-wide handle outlives a temporary directory, and loadConfig
  // reaches for it. Left alone, the second test in this file reads a database
  // in a directory the first one deleted, which surfaces as a disk I/O error
  // rather than as a failed assertion.
  setDb(openDb(join(dir, 'aalai.sqlite')))
})

afterEach(() => {
  setDb(undefined)
  rmSync(dir, { recursive: true, force: true })
  // delete, not assignment: setting an env var to undefined stores the string
  // "undefined", and every later test then opens a database in a directory of
  // that name.
  delete process.env.AALAI_STATE_DIR
})

/**
 * Seeds through a connection that is opened and closed per call.
 *
 * The routes do the same. Holding a second long lived handle open across a
 * temporary directory that gets removed is what produced disk I/O errors here
 * rather than assertion failures, which is a much worse way to find out.
 */
function seed<T>(fn: (db: ReturnType<typeof openDb>['sqlite']) => T): T {
  return fn(openDb(join(dir, 'aalai.sqlite')).sqlite)
}

const get = (path: string) => app.request(path)
const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const del = (path: string) => app.request(path, { method: 'DELETE' })

describe('reading the queue', () => {
  test('reports capacity even when it is empty', async () => {
    const res = await get('/api/queue')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entries).toEqual([])
    expect(body.running).toBe(0)
    // The default, which is what a laptop gets unless somebody says otherwise.
    expect(body.capacity).toBe(2)
    expect(body.paused).toBe(false)
  })

  test('filters by status', async () => {
    seed((db) => offerRun(db, { repo: 'acme/app', kind: 'issue', number: 1 }))
    seed((db) => offerRun(db, { repo: 'acme/app', kind: 'issue', number: 2 }))
    seed((db) => enqueueRun(db, 'acme/app', 'issue', 2))
    const res = await get('/api/queue?status=offered')
    const body = await res.json()
    expect(body.entries.map((e: { number: number }) => e.number)).toEqual([1])
  })

  test('refuses a status that is not one', async () => {
    expect((await get('/api/queue?status=banana')).status).toBe(400)
  })
})

describe('queueing', () => {
  test('an offer can be queued', async () => {
    seed((db) => offerRun(db, { repo: 'acme/app', kind: 'issue', number: 7 }))
    const res = await post('/api/queue/acme/app/issue/7')
    expect(res.status).toBe(200)
    expect((await res.json()).entry.status).toBe('queued')
  })

  test('something already running is refused rather than queued twice', async () => {
    seed((db) => offerRun(db, { repo: 'acme/app', kind: 'issue', number: 7 }))
    seed((db) => enqueueRun(db, 'acme/app', 'issue', 7))
    seed((db) => claimRun(db, 'acme/app', 7))
    const res = await post('/api/queue/acme/app/issue/7')
    expect(res.status).toBe(409)
  })

  test('a pull request queues the same way an issue does', async () => {
    seed((db) => offerRun(db, { repo: 'acme/app', kind: 'pr', number: 12 }))
    expect((await post('/api/queue/acme/app/pr/12')).status).toBe(200)
    expect(seed((db) => readRun(db, 'acme/app', 'pr', 12))?.status).toBe(
      'queued',
    )
  })

  test('a subject number that is not a number is refused', async () => {
    expect((await post('/api/queue/acme/app/issue/abc')).status).toBe(400)
  })
})

describe('dismissing', () => {
  test('an offer can be dismissed', async () => {
    seed((db) => offerRun(db, { repo: 'acme/app', kind: 'issue', number: 7 }))
    expect((await del('/api/queue/acme/app/issue/7')).status).toBe(200)
    expect(seed((db) => readRun(db, 'acme/app', 'issue', 7))?.status).toBe(
      'skipped',
    )
  })

  test('a running run cannot be dismissed out from under itself', async () => {
    seed((db) => offerRun(db, { repo: 'acme/app', kind: 'issue', number: 7 }))
    seed((db) => enqueueRun(db, 'acme/app', 'issue', 7))
    seed((db) => claimRun(db, 'acme/app', 7))
    expect((await del('/api/queue/acme/app/issue/7')).status).toBe(409)
  })
})

describe('starting by hand', () => {
  test('is refused when every slot is busy, rather than queued silently', async () => {
    // A Start button that quietly means "eventually" is a broken button.
    for (const n of [1, 2]) {
      seed((db) => offerRun(db, { repo: 'acme/app', kind: 'issue', number: n }))
      seed((db) => enqueueRun(db, 'acme/app', 'issue', n))
      seed((db) => claimRun(db, 'acme/app', n))
    }
    seed((db) => offerRun(db, { repo: 'acme/app', kind: 'issue', number: 3 }))
    const res = await post('/api/queue/acme/app/issue/3/start')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('no free slot')
  })

  test('the refusal says how many are running, so the number is actionable', async () => {
    seed((db) => writeDomain(db, 'factory', { maxParallelRuns: 1 } as never))
    seed((db) => offerRun(db, { repo: 'acme/app', kind: 'issue', number: 1 }))
    seed((db) => enqueueRun(db, 'acme/app', 'issue', 1))
    seed((db) => claimRun(db, 'acme/app', 1))
    seed((db) => offerRun(db, { repo: 'acme/app', kind: 'issue', number: 2 }))
    const res = await post('/api/queue/acme/app/issue/2/start')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('1 already running')
  })
})

describe('pausing', () => {
  test('is recorded and read back', async () => {
    expect((await post('/api/queue/pause', { paused: true })).status).toBe(200)
    expect((await (await get('/api/queue')).json()).paused).toBe(true)
    await post('/api/queue/pause', { paused: false })
    expect((await (await get('/api/queue')).json()).paused).toBe(false)
  })

  test('needs a boolean', async () => {
    expect((await post('/api/queue/pause', { paused: 'yes' })).status).toBe(400)
  })
})
