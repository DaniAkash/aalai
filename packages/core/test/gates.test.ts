import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/modules/db/db'
import {
  answerGate,
  gateId,
  listGates,
  openGate,
  readGate,
  supersedeOpenGates,
} from '@/modules/gates'

let dir: string
let handle: ReturnType<typeof openDb>
let db: ReturnType<typeof openDb>['sqlite']

const RUN_ID = 'acme/widgets#7@1790000000000'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-gates-'))
  handle = openDb(join(dir, 'aalai.sqlite'))
  db = handle.sqlite
})

afterEach(() => {
  handle.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('opening', () => {
  test('a gate opens once, and re-entering the state adopts it', () => {
    const first = openGate(db, {
      runId: RUN_ID,
      kind: 'plan',
      artifactPath: 'plan.v1.md',
      artifactVersion: '1',
    })
    const second = openGate(db, {
      runId: RUN_ID,
      kind: 'plan',
      artifactPath: 'plan.v1.md',
      artifactVersion: '1',
    })

    expect(second).toBe(first)
    expect(listGates(db, { runId: RUN_ID })).toHaveLength(1)
  })

  test('a gate on a new version is a different gate', () => {
    const v1 = openGate(db, {
      runId: RUN_ID,
      kind: 'plan',
      artifactVersion: '1',
    })
    const v2 = openGate(db, {
      runId: RUN_ID,
      kind: 'plan',
      artifactVersion: '2',
    })

    expect(v2).not.toBe(v1)
    expect(listGates(db, { runId: RUN_ID })).toHaveLength(2)
  })
})

describe('answering', () => {
  test('an approval is recorded with who answered and from where', () => {
    const id = openGate(db, {
      runId: RUN_ID,
      kind: 'plan',
      artifactVersion: '1',
    })

    const result = answerGate(db, {
      gateId: id,
      decision: 'approved',
      answeredBy: 'maintainer',
      answeredOn: 'cli',
    })

    expect(result.ok).toBe(true)
    const gate = readGate(db, id)
    expect(gate?.status).toBe('answered')
    expect(gate?.decision).toBe('approved')
    expect(gate?.answeredOn).toBe('cli')
    expect(gate?.answeredAt).not.toBeNull()
  })

  test('a second answer is refused rather than overwriting the first', () => {
    const id = openGate(db, {
      runId: RUN_ID,
      kind: 'plan',
      artifactVersion: '1',
    })
    answerGate(db, {
      gateId: id,
      decision: 'approved',
      answeredBy: 'the app',
      answeredOn: 'app',
    })

    const second = answerGate(db, {
      gateId: id,
      decision: 'rejected',
      answeredBy: 'a terminal',
      answeredOn: 'cli',
    })

    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('unreachable')
    expect(second.refusal.kind).toBe('already_answered')
    // The point of the refusal: the first answer still stands.
    expect(readGate(db, id)?.decision).toBe('approved')
  })

  test('answering an unknown gate is refused, not thrown', () => {
    const result = answerGate(db, {
      gateId: 'nothing/here:plan:1',
      decision: 'approved',
      answeredBy: 'maintainer',
      answeredOn: 'cli',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.kind).toBe('not_found')
  })

  test('a reason is kept, because it becomes the issue comment', () => {
    const id = openGate(db, {
      runId: RUN_ID,
      kind: 'plan',
      artifactVersion: '1',
    })

    answerGate(db, {
      gateId: id,
      decision: 'changes',
      reason: 'the criteria do not mention the error path',
      answeredBy: 'maintainer',
      answeredOn: 'cli',
    })

    expect(readGate(db, id)?.reason).toBe(
      'the criteria do not mention the error path',
    )
  })
})

describe('superseding, which is what stops an approval transferring', () => {
  test('a gate whose artifact was rewritten can no longer be answered', () => {
    const v1 = openGate(db, {
      runId: RUN_ID,
      kind: 'plan',
      artifactPath: 'plan.v1.md',
      artifactVersion: '1',
    })

    // The analyst writes a new version. Everything still open is retired.
    expect(supersedeOpenGates(db, RUN_ID, 'plan')).toBe(1)

    const result = answerGate(db, {
      gateId: v1,
      decision: 'approved',
      answeredBy: 'maintainer',
      answeredOn: 'cli',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.kind).toBe('superseded')
    expect(readGate(db, v1)?.decision).toBeNull()
  })

  test('superseding leaves an already answered gate alone', () => {
    const id = openGate(db, {
      runId: RUN_ID,
      kind: 'plan',
      artifactVersion: '1',
    })
    answerGate(db, {
      gateId: id,
      decision: 'approved',
      answeredBy: 'maintainer',
      answeredOn: 'cli',
    })

    expect(supersedeOpenGates(db, RUN_ID, 'plan')).toBe(0)
    expect(readGate(db, id)?.status).toBe('answered')
  })
})

describe('listing, which is what the inbox asks', () => {
  test('open gates only, newest first', () => {
    const a = openGate(db, {
      runId: 'a#1@1',
      kind: 'plan',
      artifactVersion: '1',
    })
    const b = openGate(db, {
      runId: 'b#2@2',
      kind: 'plan',
      artifactVersion: '1',
    })
    answerGate(db, {
      gateId: a,
      decision: 'approved',
      answeredBy: 'maintainer',
      answeredOn: 'cli',
    })

    const open = listGates(db, { status: 'open' })

    expect(open.map((g) => g.id)).toEqual([b])
  })
})

describe('the id', () => {
  test('is stable for the same question and different for a new version', () => {
    const one = gateId({ runId: RUN_ID, kind: 'plan', artifactVersion: '1' })
    const again = gateId({ runId: RUN_ID, kind: 'plan', artifactVersion: '1' })
    const next = gateId({ runId: RUN_ID, kind: 'plan', artifactVersion: '2' })

    expect(again).toBe(one)
    expect(next).not.toBe(one)
  })
})
