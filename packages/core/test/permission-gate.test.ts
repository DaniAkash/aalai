import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AcpPermissionRequest } from 'acpx/runtime'
import { openDb } from '@/modules/db/db'
import { answerGate, listGates, readGate } from '@/modules/gates'
import { permissionGate } from '@/run/permissionGate'

let dir: string
let handle: ReturnType<typeof openDb>

const RUN_ID = 'acme/widgets#7@1790000000000'

const request = {
  sessionId: 'session-1',
  inferredKind: 'edit',
  raw: { toolCall: { title: 'write src/index.ts' } },
} as unknown as AcpPermissionRequest

function gate(waitMs: number) {
  return permissionGate({
    db: handle.sqlite,
    runId: RUN_ID,
    repo: 'acme/widgets',
    issue: 7,
    station: 'implementer',
    waitMs,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-perm-'))
  process.env.AALAI_STATE_DIR = dir
  handle = openDb(join(dir, 'aalai.sqlite'))
})

afterEach(() => {
  handle.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('falling through, which is the property that matters', () => {
  test('nobody answering returns undefined rather than stalling the turn', async () => {
    const decision = await gate(300)(request, {
      signal: new AbortController().signal,
    })

    // undefined hands the call back to the station's permission mode, which is
    // exactly the behaviour with this feature switched off.
    expect(decision).toBeUndefined()
  })

  test('an unanswered question expires rather than recording a decision', async () => {
    await gate(300)(request, { signal: new AbortController().signal })

    expect(listGates(handle.sqlite, { status: 'open' })).toHaveLength(0)
    const [gone] = listGates(handle.sqlite, { status: 'expired' })
    expect(gone?.status).toBe('expired')
    // Nobody decided anything, so the history must not claim somebody did.
    expect(gone?.decision).toBeNull()
    expect(gone?.answeredBy).toBeNull()
  })

  test('a stopped run gives up immediately instead of waiting out the clock', async () => {
    const controller = new AbortController()
    controller.abort()

    const started = Date.now()
    const decision = await gate(10_000)(request, { signal: controller.signal })

    expect(decision).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('answering', () => {
  test('an approval becomes allow_once', async () => {
    const pending = gate(5000)(request, {
      signal: new AbortController().signal,
    })
    await waitForGate()
    const [open] = listGates(handle.sqlite, { status: 'open' })
    if (open === undefined) throw new Error('no question was asked')
    answerGate(handle.sqlite, {
      gateId: open.id,
      decision: 'approved',
      answeredBy: 'maintainer',
      answeredOn: 'cli',
    })

    expect(await pending).toEqual({ outcome: 'allow_once' })
  })

  test('a rejection becomes reject_once and is recorded', async () => {
    const pending = gate(5000)(request, {
      signal: new AbortController().signal,
    })
    await waitForGate()
    const [open] = listGates(handle.sqlite, { status: 'open' })
    if (open === undefined) throw new Error('no question was asked')
    answerGate(handle.sqlite, {
      gateId: open.id,
      decision: 'rejected',
      reason: 'not that file',
      answeredBy: 'maintainer',
      answeredOn: 'cli',
    })

    expect(await pending).toEqual({ outcome: 'reject_once' })
    expect(readGate(handle.sqlite, open.id)?.reason).toBe('not that file')
  })
})

async function waitForGate(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (listGates(handle.sqlite, { status: 'open' }).length > 0) return
    await Bun.sleep(20)
  }
  throw new Error('the gate never opened')
}

describe('every ask is its own question', () => {
  test('a burst of asks produces one gate each, not one shared gate', async () => {
    // Fired together so they land inside the same millisecond, which is what a
    // run of tool calls looks like and what a clock based id cannot separate.
    const asks = Array.from({ length: 25 }, () =>
      gate(200)(request, { signal: new AbortController().signal }),
    )
    await waitForGate()
    const opened = listGates(handle.sqlite, { limit: 200 }).filter(
      (row) => row.kind === 'permission',
    )

    // One row per question. Anything fewer means two different actions were
    // collapsed into one, and a single answer would decide both.
    expect(opened).toHaveLength(asks.length)
    await Promise.all(asks)
  })
})

describe('never breaking the run it supervises', () => {
  test('a database it cannot write falls through instead of throwing', async () => {
    // The station must keep its own permission mode when this feature cannot
    // do its job, rather than the turn failing on a supervision feature.
    const broken = {
      query: () => {
        throw new Error('database is locked')
      },
      transaction: () => {
        throw new Error('database is locked')
      },
    } as unknown as typeof handle.sqlite

    const decision = await permissionGate({
      db: broken,
      runId: RUN_ID,
      repo: 'acme/widgets',
      issue: 7,
      station: 'implementer',
      waitMs: 500,
    })(request, { signal: new AbortController().signal })

    expect(decision).toBeUndefined()
  })

  test('the question records what it is asking', async () => {
    const pending = gate(5000)(request, {
      signal: new AbortController().signal,
    })
    await waitForGate()
    const [open] = listGates(handle.sqlite, { status: 'open' })

    expect(open?.summary).toBe('edit')

    answerGate(handle.sqlite, {
      gateId: open?.id ?? '',
      decision: 'approved',
      answeredBy: 'maintainer',
      answeredOn: 'cli',
    })
    await pending
  })
})
