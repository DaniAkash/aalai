import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor, waitFor } from 'xstate'
import type { Config } from '@/config'
import type { GhIssue } from '@/lib/gh'
import { openDb } from '@/modules/db/db'
import type { RunRef, Subject } from '@/modules/work/paths'
import { writeJson } from '@/modules/work/store'
import { analyst, reviewer } from '@/run/machines/actors'
import { attemptIdFor, beginAttempt } from '@/run/machines/attempts'
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

async function settle<T>(
  logic: Parameters<typeof createActor>[0],
  input: unknown,
) {
  const actor = createActor(logic, { input } as never)
  actor.start()
  const snapshot = await waitFor(actor, (s) => s.status !== 'active')
  return snapshot as { status: string; output: T; error: unknown }
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
    expect(settled.output.problem_statement).toBe('recovered from disk')
  })

  test('the reviewer answers from the verdict it already recorded', async () => {
    await writeJson(RUN, 'review', review)
    beginAttempt(db.sqlite, {
      id: attemptIdFor(RUN_ID, 'reviewer', 0),
      runId: RUN_ID,
      station: 'reviewer',
    })

    const settled = await settle<{ review: Review }>(reviewer, {
      runId: RUN_ID,
      revision: 0,
    })

    expect(settled.status).toBe('done')
    expect(settled.output.review.criteria_results[0]?.evidence).toBe(
      'recovered from disk',
    )
  })

  test('the reviewer does not rebuild a checkout it has no use for', async () => {
    await writeJson(RUN, 'review', review)
    beginAttempt(db.sqlite, {
      id: attemptIdFor(RUN_ID, 'reviewer', 0),
      runId: RUN_ID,
      station: 'reviewer',
    })

    const settled = await settle<{ review: Review; worktree?: string }>(
      reviewer,
      { runId: RUN_ID, revision: 0 },
    )

    // No clone exists here, so rebuilding one would have thrown. Answering
    // from the record is what makes that unnecessary.
    expect(settled.status).toBe('done')
    expect(settled.output.worktree).toBeUndefined()
  })
})
