import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/modules/db/db'
import type { RunRef, Subject } from '@/modules/work/paths'
import { issueWorkMachine } from '@/run/machines/issueWork'
import { persistSnapshot, unfinishedRuns } from '@/run/machines/snapshots'
import {
  gateActivity,
  WORK_STATES,
  type WorkState,
  workState,
} from '@/run/machines/types'

/**
 * `machine_snapshots.value` is queried, not just stored: `unfinishedRuns`
 * filters it to decide what to resume on start. So the string `workState`
 * produces is a contract, and these are the tests that hold it.
 *
 * The specific failure they exist to prevent: before `gatingPlan` had
 * substates, `workState` fell through to `String(value)` for an object, so the
 * first compound state would have written "[object Object]" into that column on
 * every transition, and an eval waiting for 'gatingPlan' would have hung rather
 * than failed.
 */

let dir: string
let db: ReturnType<typeof openDb>

const SUBJECT: Subject = { repo: 'acme/widgets', kind: 'issue', number: 7 }
const RUN_ID = 'acme/widgets#7@1790000000000'
const RUN: RunRef = { subject: SUBJECT, runId: RUN_ID }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-contract-'))
  process.env.AALAI_STATE_DIR = dir
  db = openDb(join(dir, 'aalai.sqlite'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function record(value: string): Promise<void> {
  await persistSnapshot({
    db: db.sqlite,
    run: RUN,
    runId: RUN_ID,
    machine: 'issueWork',
    value,
    snapshot: { value },
  })
}

describe('the vocabulary of the persisted value', () => {
  test('every state the machine declares is one the column expects', () => {
    const declared = Object.keys(
      (issueWorkMachine.config.states as { work: { states: object } }).work
        .states,
    )
    expect([...declared].sort()).toEqual([...WORK_STATES].sort())
  })

  test('a compound work state reports its own name, not its substate', () => {
    expect(workState({ work: { gatingPlan: 'waiting' } })).toBe('gatingPlan')
    expect(workState({ work: { gatingPlan: 'answering' } })).toBe('gatingPlan')
  })

  test('a leaf work state is unchanged, which is every state today', () => {
    for (const state of WORK_STATES) {
      expect(workState({ work: state, premise: 'watching' })).toBe(state)
    }
  })

  test('nothing reachable ever stringifies to an object', () => {
    const shapes: unknown[] = [
      'planning',
      { work: 'gatingPlan', premise: 'watching' },
      { work: { gatingPlan: 'waiting' }, premise: 'watching' },
      { work: { gatingPlan: 'answering' }, premise: 'done' },
      { work: { implementing: 'running' }, premise: 'watching' },
    ]
    for (const shape of shapes) {
      expect(workState(shape)).not.toContain('[object')
    }
  })

  test('the value written for any reachable shape is in the vocabulary', () => {
    const shapes: unknown[] = [
      { work: 'planning', premise: 'watching' },
      { work: { gatingPlan: 'waiting' }, premise: 'watching' },
      { work: { gatingPlan: 'answering' }, premise: 'watching' },
      { work: 'approved', premise: 'done' },
    ]
    for (const shape of shapes) {
      expect(WORK_STATES).toContain(workState(shape) as WorkState)
    }
  })
})

describe('the substate, which is for a screen and not for a column', () => {
  test('it reads the activity inside the gate', () => {
    expect(gateActivity({ work: { gatingPlan: 'waiting' } })).toBe('waiting')
    expect(gateActivity({ work: { gatingPlan: 'answering' } })).toBe(
      'answering',
    )
  })

  test('a run that is not parked has no activity', () => {
    expect(gateActivity({ work: 'implementing' })).toBeUndefined()
    expect(gateActivity('planning')).toBeUndefined()
  })

  test('an unknown substate is not invented', () => {
    expect(gateActivity({ work: { gatingPlan: 'dancing' } })).toBeUndefined()
  })
})

describe('what the column is for', () => {
  test('FINAL names states the machine can actually report', async () => {
    // A rename that left FINAL pointing at nothing would make every finished
    // run resumable forever, silently.
    for (const value of ['approved', 'finished']) {
      expect(WORK_STATES).toContain(value as WorkState)
      await record(value)
      expect(unfinishedRuns(db.sqlite)).toEqual([])
    }
  })

  test('a run parked at a gate is offered for resume', async () => {
    await record(workState({ work: { gatingPlan: 'waiting' } }))
    expect(unfinishedRuns(db.sqlite).map((r) => r.runId)).toEqual([RUN_ID])
  })

  test('a run mid reply is offered too, and the row still says gatingPlan', async () => {
    await record(workState({ work: { gatingPlan: 'answering' } }))
    const [row] = unfinishedRuns(db.sqlite)
    expect(row?.runId).toBe(RUN_ID)
    // The substate must not reach the column: it is queried, not decorative.
    expect(row?.value).toBe('gatingPlan')
  })

  test('a row written before the gate had substates still resumes', async () => {
    // A code change does not migrate a database. Rows saying 'gatingPlan' exist
    // in real installations and have to keep meaning what they meant.
    await record('gatingPlan')
    const [row] = unfinishedRuns(db.sqlite)
    expect(row?.value).toBe('gatingPlan')
    expect(row?.runId).toBe(RUN_ID)
  })
})
