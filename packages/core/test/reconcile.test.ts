import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import type { Config } from '@/config'
import type { GhIssue } from '@/lib/gh'
import { openDb } from '@/modules/db/db'
import { writeArtifact } from '@/modules/work/artifacts'
import type { RunRef, Subject } from '@/modules/work/paths'
import { writeJson } from '@/modules/work/store'
import { analyst, reviewer } from '@/run/machines/actors'
import {
  attemptIdFor,
  beginAttempt,
  writeAttemptBefore,
} from '@/run/machines/attempts'
import { provideRunDeps, releaseRunDeps } from '@/run/machines/deps'
import type { Analysis, Review } from '@/run/stations/schemas'
import type { Workspace } from '@/run/workspace'

let dir: string
let db: ReturnType<typeof openDb>

const SUBJECT: Subject = { repo: 'acme/widgets', kind: 'issue', number: 7 }
const RUN_ID = 'acme/widgets#7@1790000000000'
const RUN: RunRef = { subject: SUBJECT, runId: RUN_ID }

const analysis: Analysis = {
  problem_statement: 'recovered from disk',
  approach: 'a',
  plan: ['one'],
  affected_surface: [],
  risks: [],
  acceptance_criteria: ['it works'],
  test_strategy: 't',
}

const review: Review = {
  verdict: 'approve',
  criteria_results: [
    { criterion: 'it works', pass: true, evidence: 'recovered from disk' },
  ],
  blocking_findings: [],
  summary: 'fine',
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-reconcile-'))
  process.env.AALAI_STATE_DIR = dir
  db = openDb(join(dir, 'aalai.sqlite'))
  provideRunDeps(RUN_ID, {
    db: db.sqlite,
    // Only the reconcile paths are exercised here, and none of them reach the
    // agent, the worktree or the config. Executing would throw, which is the
    // assertion: a reconciled attempt must not run the station.
    config: { maxRevisions: 2 } as Config,
    issue: { number: 7, title: 'a title' } as GhIssue,
    repo: 'acme/widgets',
    workspace: {
      repo: 'acme/widgets',
      issueNumber: 7,
      clonePath: join(dir, 'clone'),
      worktreePath: join(dir, 'missing'),
      base: 'main',
      branch: 'aalai/issue-7',
    } satisfies Workspace,
    run: RUN,
    conventionFiles: [],
  })
})

afterEach(() => {
  releaseRunDeps(RUN_ID)
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Runs one actor to a settled state.
 *
 * Subscribed rather than awaited, because an actor that errors reports it
 * through the subscription and rejects anything waiting on it. Erroring is a
 * legitimate outcome here: a station that refuses to reconcile is supposed to
 * run, and one that cannot run is supposed to fail rather than invent an answer.
 */
function settle<T>(
  logic: Parameters<typeof createActor>[0],
  input: unknown,
): Promise<{ status: string; output?: T }> {
  return new Promise((resolve) => {
    const actor = createActor(logic, { input } as never)
    actor.subscribe({
      next: (snapshot) => {
        if (snapshot.status === 'done') {
          resolve({
            status: 'done',
            output: (snapshot as { output?: T }).output,
          })
        }
      },
      error: () => resolve({ status: 'error' }),
    })
    actor.start()
  })
}

describe('an attempt that started and never settled', () => {
  test('the analyst answers from the plan it already wrote', async () => {
    await writeJson(RUN, 'analysis', analysis)
    beginAttempt(db.sqlite, {
      id: attemptIdFor(RUN_ID, 'analyst', 0),
      runId: RUN_ID,
      station: 'analyst',
    })

    const settled = await settle<Analysis>(analyst, { runId: RUN_ID })

    expect(settled.status).toBe('done')
    expect(settled.output?.problem_statement).toBe('recovered from disk')
  })

  test('the reviewer answers from a verdict written after it began', async () => {
    await writeJson(RUN, 'review', review)
    await writeArtifact(SUBJECT, 'review', 'the verdict this attempt produced')
    const id = attemptIdFor(RUN_ID, 'reviewer', 0)
    // Nothing had been reviewed when this attempt started.
    await writeAttemptBefore(RUN, id, { reviews: 0 })
    beginAttempt(db.sqlite, { id, runId: RUN_ID, station: 'reviewer' })

    const settled = await settle<{ review: Review; worktree?: string }>(
      reviewer,
      { runId: RUN_ID, revision: 0 },
    )

    expect(settled.status).toBe('done')
    expect(settled.output?.review.criteria_results[0]?.evidence).toBe(
      'recovered from disk',
    )
    // No clone exists here, so rebuilding one would have thrown. Answering
    // from the record is what makes that unnecessary.
    expect(settled.output?.worktree).toBeUndefined()
  })

  test('a revision does not adopt the previous revision verdict', async () => {
    // review.json holds the latest verdict for the whole run, so an earlier
    // revision's verdict is sitting right there. Revision 1 began after it was
    // written, and must not mistake it for its own.
    await writeJson(RUN, 'review', review)
    await writeArtifact(SUBJECT, 'review', 'the verdict from revision 0')
    const id = attemptIdFor(RUN_ID, 'reviewer', 1)
    await writeAttemptBefore(RUN, id, { reviews: 1 })
    beginAttempt(db.sqlite, { id, runId: RUN_ID, station: 'reviewer' })

    const settled = await settle<{ review: Review }>(reviewer, {
      runId: RUN_ID,
      revision: 1,
    })

    // Nothing new was written, so reconciling answers nothing and the station
    // is asked to run. It cannot here, and failing is the correct outcome:
    // the alternative is judging code this verdict never saw.
    expect(settled.status).toBe('error')
  })
})
