import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/modules/db/db'
import type { RunRef, Subject } from '@/modules/work/paths'
import {
  attemptIdFor,
  beginAttempt,
  readAttempt,
  writeAttemptBefore,
} from '@/run/machines/attempts'
import { runAttempt } from '@/run/machines/runner'

let dir: string
let db: ReturnType<typeof openDb>

const SUBJECT: Subject = { repo: 'acme/widgets', kind: 'issue', number: 7 }
const RUN_ID = 'acme/widgets#7@1790000000000'
const RUN: RunRef = { subject: SUBJECT, runId: RUN_ID }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-attempt-'))
  process.env.AALAI_STATE_DIR = dir
  db = openDb(join(dir, 'aalai.sqlite'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the attempt id', () => {
  test('is the same across a restart, which is what makes it a key', () => {
    expect(attemptIdFor(RUN_ID, 'analyst', 0)).toBe(
      attemptIdFor(RUN_ID, 'analyst', 0),
    )
  })

  test('separates stations and revisions', () => {
    expect(attemptIdFor(RUN_ID, 'analyst', 0)).not.toBe(
      attemptIdFor(RUN_ID, 'implementer', 0),
    )
    expect(attemptIdFor(RUN_ID, 'implementer', 0)).not.toBe(
      attemptIdFor(RUN_ID, 'implementer', 1),
    )
  })
})

describe('running a station attempt', () => {
  test('runs the work the first time', async () => {
    let ran = 0
    const outcome = await runAttempt({
      db: db.sqlite,
      run: RUN,
      runId: RUN_ID,
      station: 'analyst',
      revision: 0,
      execute: async () => {
        ran += 1
        return { plan: 'the plan' }
      },
    })
    expect(outcome.source).toBe('executed')
    expect(outcome.value).toEqual({ plan: 'the plan' })
    expect(ran).toBe(1)
  })

  test('a second invocation returns the record without running again', async () => {
    let ran = 0
    const execute = async () => {
      ran += 1
      return { plan: `run ${ran}` }
    }
    const input = {
      db: db.sqlite,
      run: RUN,
      runId: RUN_ID,
      station: 'analyst' as const,
      revision: 0,
      execute,
    }

    await runAttempt(input)
    // This is the restart: xstate restarts invocations, so the same attempt is
    // invoked a second time and must not spend another agent turn.
    const second = await runAttempt(input)

    expect(ran).toBe(1)
    expect(second.source).toBe('recorded')
    expect(second.value).toEqual({ plan: 'run 1' })
  })

  test('an attempt that started and never settled reconciles against reality', async () => {
    let ran = 0
    beginAttempt(db.sqlite, {
      id: attemptIdFor(RUN_ID, 'implementer', 0),
      runId: RUN_ID,
      station: 'implementer',
    })

    const outcome = await runAttempt({
      db: db.sqlite,
      run: RUN,
      runId: RUN_ID,
      station: 'implementer',
      revision: 0,
      execute: async () => {
        ran += 1
        return { sha: 'fresh' }
      },
      // The commit is on the branch already, which is what a crash between
      // doing the work and recording it looks like.
      reconcile: async () => ({ sha: 'already-committed' }),
    })

    expect(ran).toBe(0)
    expect(outcome.source).toBe('reconciled')
    expect(outcome.value).toEqual({ sha: 'already-committed' })
    expect(
      readAttempt(db.sqlite, attemptIdFor(RUN_ID, 'implementer', 0))?.status,
    ).toBe('succeeded')
  })

  test('when reality says nothing landed, the work runs', async () => {
    let ran = 0
    beginAttempt(db.sqlite, {
      id: attemptIdFor(RUN_ID, 'implementer', 0),
      runId: RUN_ID,
      station: 'implementer',
    })

    const outcome = await runAttempt({
      db: db.sqlite,
      run: RUN,
      runId: RUN_ID,
      station: 'implementer',
      revision: 0,
      execute: async () => {
        ran += 1
        return { sha: 'fresh' }
      },
      reconcile: async () => undefined,
    })

    expect(ran).toBe(1)
    expect(outcome.source).toBe('executed')
  })

  test('a failure is recorded and rethrown, so nothing reads it as done', async () => {
    await expect(
      runAttempt({
        db: db.sqlite,
        run: RUN,
        runId: RUN_ID,
        station: 'reviewer',
        revision: 0,
        execute: async () => {
          throw new Error('the turn timed out')
        },
      }),
    ).rejects.toThrow('the turn timed out')

    expect(
      readAttempt(db.sqlite, attemptIdFor(RUN_ID, 'reviewer', 0))?.status,
    ).toBe('failed')
  })

  test('a failed attempt runs again rather than replaying a failure', async () => {
    let ran = 0
    const input = {
      db: db.sqlite,
      run: RUN,
      runId: RUN_ID,
      station: 'reviewer' as const,
      revision: 0,
      execute: async () => {
        ran += 1
        if (ran === 1) throw new Error('first time fails')
        return { verdict: 'approve' }
      },
    }
    await expect(runAttempt(input)).rejects.toThrow()
    const second = await runAttempt(input)

    expect(ran).toBe(2)
    expect(second.source).toBe('executed')
  })

  test('a record with no document on disk does the work rather than assume it', async () => {
    let ran = 0
    const input = {
      db: db.sqlite,
      run: RUN,
      runId: RUN_ID,
      station: 'analyst' as const,
      revision: 0,
      execute: async () => {
        ran += 1
        return { plan: 'the plan' }
      },
    }
    await runAttempt(input)

    // The row still says succeeded, but the outcome document is gone.
    rmSync(join(dir, 'work'), { recursive: true, force: true })
    const second = await runAttempt(input)

    expect(ran).toBe(2)
    expect(second.source).toBe('executed')
  })
})

describe('reconciling against where the work started', () => {
  test('a later revision does not inherit an earlier one as its own', async () => {
    let ran = 0
    // Revision 0 committed, so anything comparing against the base sees a
    // change and would call revision 1 finished without it doing anything.
    const headAtStart = 'sha-after-revision-0'
    let head = headAtStart

    const attempt = (revision: number) => ({
      db: db.sqlite,
      run: RUN,
      runId: RUN_ID,
      station: 'implementer' as const,
      revision,
      captureBefore: async () => ({ head }),
      reconcile: async (
        before: { head: string } | undefined,
      ): Promise<{ sha: string; from: string } | undefined> =>
        before !== undefined && head !== before.head
          ? { sha: head, from: 'reconciled' }
          : undefined,
      execute: async (): Promise<{ sha: string; from: string }> => {
        ran += 1
        head = `sha-from-revision-${revision}`
        return { sha: head, from: 'executed' }
      },
    })

    // Revision 1 starts and is interrupted before it does anything.
    const input = attempt(1)
    await writeAttemptBefore(RUN, attemptIdFor(RUN_ID, 'implementer', 1), {
      head: headAtStart,
    })
    beginAttempt(db.sqlite, {
      id: attemptIdFor(RUN_ID, 'implementer', 1),
      runId: RUN_ID,
      station: 'implementer',
    })

    const outcome = await runAttempt(input)

    // Nothing new was committed, so the revision has to actually run.
    expect(outcome.source).toBe('executed')
    expect(ran).toBe(1)
  })

  test('a revision that did commit is reconciled rather than repeated', async () => {
    let ran = 0
    const before = { head: 'sha-before' }
    await writeAttemptBefore(
      RUN,
      attemptIdFor(RUN_ID, 'implementer', 1),
      before,
    )
    beginAttempt(db.sqlite, {
      id: attemptIdFor(RUN_ID, 'implementer', 1),
      runId: RUN_ID,
      station: 'implementer',
    })

    const outcome = await runAttempt({
      db: db.sqlite,
      run: RUN,
      runId: RUN_ID,
      station: 'implementer',
      revision: 1,
      captureBefore: async () => before,
      // The commit landed before the process died.
      reconcile: async (stored: { head: string } | undefined) =>
        stored?.head === 'sha-before' ? { sha: 'sha-after' } : undefined,
      execute: async () => {
        ran += 1
        return { sha: 'fresh' }
      },
    })

    expect(outcome.source).toBe('reconciled')
    expect(ran).toBe(0)
  })
})
