import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor, fromPromise, waitFor } from 'xstate'
import { openDb } from '@/modules/db/db'
import type { RunRef, Subject } from '@/modules/work/paths'
import type { CommitOutcome } from '@/run/commit'
import { issueWorkMachine } from '@/run/machines/issueWork'
import {
  persistSnapshot,
  readSnapshot,
  unfinishedRuns,
} from '@/run/machines/snapshots'
import { workState } from '@/run/machines/types'
import { parseRunId } from '@/run/resume'
import type { Analysis, Review } from '@/run/stations/schemas'

let dir: string
let db: ReturnType<typeof openDb>

const SUBJECT: Subject = { repo: 'acme/widgets', kind: 'issue', number: 7 }
const RUN_ID = 'acme/widgets#7@1790000000000'
const RUN: RunRef = { subject: SUBJECT, runId: RUN_ID }

const analysis: Analysis = {
  problem_statement: 'p',
  approach: 'a',
  plan: ['one'],
  affected_surface: [],
  risks: [],
  acceptance_criteria: ['it works'],
  test_strategy: 't',
}

const approval: Review = {
  verdict: 'approve',
  criteria_results: [
    { criterion: 'it works', pass: true, evidence: 'checked' },
  ],
  blocking_findings: [],
  summary: 'fine',
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-resume-'))
  process.env.AALAI_STATE_DIR = dir
  db = openDb(join(dir, 'aalai.sqlite'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('naming a run', () => {
  test('a run id says which repository and issue it is about', () => {
    expect(parseRunId('acme/widgets#7@1790000000000')).toEqual({
      repo: 'acme/widgets',
      issueNumber: 7,
    })
  })

  test('a repository with a dash or a dot still parses', () => {
    expect(parseRunId('DaniAkash/aalai-demo#42@1')).toEqual({
      repo: 'DaniAkash/aalai-demo',
      issueNumber: 42,
    })
  })

  test('something that is not a run id is refused rather than guessed at', () => {
    for (const bad of ['', 'nonsense', 'acme/widgets#notanumber@1']) {
      expect(parseRunId(bad)).toBeUndefined()
    }
  })
})

describe('finding what to pick back up', () => {
  test('a run parked mid flight is offered, a finished one is not', async () => {
    await persistSnapshot({
      db: db.sqlite,
      run: RUN,
      runId: RUN_ID,
      machine: 'issueWork',
      value: 'implementing',
      snapshot: { status: 'active' },
    })
    expect(unfinishedRuns(db.sqlite).map((r) => r.runId)).toEqual([RUN_ID])

    await persistSnapshot({
      db: db.sqlite,
      run: RUN,
      runId: RUN_ID,
      machine: 'issueWork',
      value: 'approved',
      snapshot: { status: 'done' },
    })
    expect(unfinishedRuns(db.sqlite)).toEqual([])
  })

  test('the snapshot comes back off disk, not out of the row', async () => {
    await persistSnapshot({
      db: db.sqlite,
      run: RUN,
      runId: RUN_ID,
      machine: 'issueWork',
      value: 'reviewing',
      snapshot: { marker: 'the whole document' },
    })
    expect(await readSnapshot(RUN)).toEqual({ marker: 'the whole document' })
  })

  test('a row with no document on disk offers nothing to resume from', async () => {
    await persistSnapshot({
      db: db.sqlite,
      run: RUN,
      runId: RUN_ID,
      machine: 'issueWork',
      value: 'implementing',
      snapshot: { status: 'active' },
    })
    rmSync(join(dir, 'work'), { recursive: true, force: true })
    expect(await readSnapshot(RUN)).toBeUndefined()
  })
})

describe('carrying a run on from its snapshot', () => {
  /** A machine whose stations count how many times they actually ran. */
  function build(turns: {
    analyst: number
    implementer: number
    reviewer: number
  }) {
    return issueWorkMachine.provide({
      actors: {
        analyst: fromPromise(async () => {
          turns.analyst += 1
          return analysis
        }),
        implementer: fromPromise(
          async (): Promise<{ report: string; commit: CommitOutcome }> => {
            turns.implementer += 1
            return { report: 'did the work', commit: 'committed' }
          },
        ),
        reviewer: fromPromise(async () => {
          turns.reviewer += 1
          return { review: approval }
        }),
      },
    })
  }

  test('a snapshot taken mid run carries its context across', async () => {
    const turns = { analyst: 0, implementer: 0, reviewer: 0 }
    const first = createActor(build(turns), {
      input: {
        runId: RUN_ID,
        repo: 'acme/widgets',
        issueNumber: 7,
        maxRevisions: 2,
        premiseBody: 'the issue text',
      },
    })
    first.start()
    const settled = await waitFor(first, (s) => s.status === 'done')
    const snapshot = JSON.parse(JSON.stringify(first.getPersistedSnapshot()))
    first.stop()

    expect(workState(settled.value)).toBe('approved')

    // What a restart does: the same machine, restored, invocations restarted.
    const resumed = createActor(build(turns), {
      input: {
        runId: RUN_ID,
        repo: 'acme/widgets',
        issueNumber: 7,
        maxRevisions: 2,
        premiseBody: 'the issue text',
      },
      snapshot,
    })
    resumed.start()
    const again = await waitFor(resumed, (s) => s.status === 'done')

    // The plan and the verdict survive the round trip, which is what makes
    // resuming different from starting over.
    expect(again.context.analysis?.acceptance_criteria).toEqual(['it works'])
    expect(again.context.review?.verdict).toBe('approve')
    expect(workState(again.value)).toBe('approved')
  })
})
