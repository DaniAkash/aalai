import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subjectDir } from '@/modules/work/paths'
import {
  readReviewRecords,
  recordReviewAnswer,
  recordReviewComments,
} from '@/modules/work/reviews'

const subject = {
  repo: 'DaniAkash/aalai-demo',
  kind: 'issue' as const,
  number: 61,
}

let home: string
let previous: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'aalai-reviews-'))
  previous = process.env.AALAI_STATE_DIR
  process.env.AALAI_STATE_DIR = home
})

afterEach(async () => {
  if (previous === undefined) {
    delete process.env.AALAI_STATE_DIR
  } else {
    process.env.AALAI_STATE_DIR = previous
  }
  await rm(home, { recursive: true, force: true })
})

const comment = (id: string, body: string) => ({
  id,
  author: 'Copilot',
  body,
  path: 'src/bytes.ts',
  line: 12,
  at: '2026-10-09T10:00:00Z',
})

describe('review records', () => {
  test('a subject with no review has no records', async () => {
    expect(await readReviewRecords(subject)).toEqual([])
  })

  test('comments are recorded and read back in order', async () => {
    await recordReviewComments(subject, [
      comment('1', 'first'),
      comment('2', 'second'),
    ])
    const records = await readReviewRecords(subject)
    expect(records.map((r) => (r.kind === 'comment' ? r.body : ''))).toEqual([
      'first',
      'second',
    ])
  })

  test('seeing the same comment again records nothing', async () => {
    // The watcher sees every comment on every poll, so this is the ordinary
    // case rather than the rare one. Without it the thread fills with copies.
    await recordReviewComments(subject, [comment('1', 'first')])
    const added = await recordReviewComments(subject, [
      comment('1', 'first'),
      comment('2', 'second'),
    ])
    expect(added.map((r) => r.id)).toEqual(['2'])
    expect(await readReviewRecords(subject)).toHaveLength(2)
  })

  test('a duplicate inside one batch is recorded once', async () => {
    const added = await recordReviewComments(subject, [
      comment('1', 'first'),
      comment('1', 'first'),
    ])
    expect(added).toHaveLength(1)
  })

  test('an answer is recorded against the comment it answers', async () => {
    await recordReviewComments(subject, [comment('1', 'first')])
    await recordReviewAnswer(subject, {
      threadId: '1',
      answer: 'Fixed by rounding rather than truncating.',
      commitSha: 'abc1234',
      station: 'reviewer',
      at: '2026-10-09T10:05:00Z',
    })
    const records = await readReviewRecords(subject)
    expect(records).toHaveLength(2)
    const answer = records[1]
    expect(answer?.kind).toBe('answer')
    if (answer?.kind === 'answer') {
      expect(answer.threadId).toBe('1')
      expect(answer.commitSha).toBe('abc1234')
    }
  })

  test('an answer with no commit is still an answer', async () => {
    // Explaining why a comment should stand is an answer, and it has no
    // commit. Dropping it would make the thread show the question forever.
    await recordReviewAnswer(subject, {
      threadId: '9',
      answer: 'This is intentional, see the comment above it.',
      commitSha: null,
      station: 'reviewer',
      at: '2026-10-09T10:06:00Z',
    })
    const records = await readReviewRecords(subject)
    expect(records[0]?.kind).toBe('answer')
  })

  test('an unreadable line costs one record, not the file', async () => {
    // Append only, written by two paths. A torn write should not take the
    // history with it.
    await recordReviewComments(subject, [comment('1', 'first')])
    const file = join(subjectDir(subject), 'reviews.jsonl')
    const text = await Bun.file(file).text()
    await writeFile(file, `${text}{"kind":"comment",broken\n`)
    await recordReviewComments(subject, [comment('2', 'second')])
    expect(await readReviewRecords(subject)).toHaveLength(2)
  })
})

describe('review turns in the thread', () => {
  test('a comment with no answer is still a turn', async () => {
    // It appears the moment the watcher sees it, which is before anything has
    // answered it. A thread that only shows answered comments would be empty
    // for exactly as long as a person is waiting.
    await recordReviewComments(subject, [
      comment('1', 'This looks off by one.'),
    ])
    const { readWorkThread } = await import('@/modules/work/thread')
    const { openState } = await import('@/watch/state')
    const db = openState()
    try {
      const view = await readWorkThread(db, subject)
      const turn = view.turns.find((t) => t.kind === 'reviewed')
      expect(turn).toBeDefined()
      if (turn?.kind === 'reviewed') {
        expect(turn.body).toBe('This looks off by one.')
        expect(turn.answer).toBeNull()
        expect(turn.commitSha).toBeNull()
      }
    } finally {
      db.close()
    }
  })

  test('the answer and its commit ride on the comment they answer', async () => {
    await recordReviewComments(subject, [comment('1', 'Off by one here.')])
    await recordReviewAnswer(subject, {
      threadId: '1',
      answer: 'Corrected the comparison.',
      commitSha: 'deadbee',
      station: 'reviewer',
      at: '2026-10-09T11:00:00Z',
    })
    const { readWorkThread } = await import('@/modules/work/thread')
    const { openState } = await import('@/watch/state')
    const db = openState()
    try {
      const view = await readWorkThread(db, subject)
      const turns = view.turns.filter((t) => t.kind === 'reviewed')
      // One turn, not two: a comment and its answer are read together.
      expect(turns).toHaveLength(1)
      const turn = turns[0]
      if (turn?.kind === 'reviewed') {
        expect(turn.answer).toBe('Corrected the comparison.')
        expect(turn.commitSha).toBe('deadbee')
      }
    } finally {
      db.close()
    }
  })

  test('an answer to a comment nobody recorded is dropped', async () => {
    // Showing an answer with nothing to answer reads as a bug rather than
    // as history.
    await recordReviewAnswer(subject, {
      threadId: '404',
      answer: 'Answering into the void.',
      commitSha: null,
      station: 'reviewer',
      at: '2026-10-09T11:00:00Z',
    })
    const { readWorkThread } = await import('@/modules/work/thread')
    const { openState } = await import('@/watch/state')
    const db = openState()
    try {
      const view = await readWorkThread(db, subject)
      expect(view.turns.filter((t) => t.kind === 'reviewed')).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  test('a comment answered twice shows the answer that stands', async () => {
    await recordReviewComments(subject, [comment('1', 'Still wrong.')])
    for (const [answer, sha] of [
      ['First attempt.', 'aaa1111'],
      ['Actually fixed now.', 'bbb2222'],
    ]) {
      await recordReviewAnswer(subject, {
        threadId: '1',
        answer: answer as string,
        commitSha: sha as string,
        station: 'reviewer',
        at: '2026-10-09T11:00:00Z',
      })
    }
    const { readWorkThread } = await import('@/modules/work/thread')
    const { openState } = await import('@/watch/state')
    const db = openState()
    try {
      const view = await readWorkThread(db, subject)
      const turn = view.turns.find((t) => t.kind === 'reviewed')
      if (turn?.kind === 'reviewed') {
        expect(turn.answer).toBe('Actually fixed now.')
        expect(turn.commitSha).toBe('bbb2222')
      }
    } finally {
      db.close()
    }
  })
})

describe('attaching the commit made after the turn', () => {
  test('an answer given in this turn gets the commit', async () => {
    // The station answers during its turn and the commit is made after it, so
    // the sha does not exist while the answer is being written.
    const { attachCommitToAnswers } = await import('@/modules/work/reviews')
    await recordReviewComments(subject, [comment('1', 'Off by one.')])
    await recordReviewAnswer(subject, {
      threadId: '1',
      answer: 'Corrected it.',
      commitSha: null,
      station: 'reviewer',
      at: '2026-10-09T12:00:00Z',
    })
    const attached = await attachCommitToAnswers(
      subject,
      'cafe1234',
      '2026-10-09T11:59:00Z',
    )
    expect(attached).toBe(1)
    const { readWorkThread } = await import('@/modules/work/thread')
    const { openState } = await import('@/watch/state')
    const db = openState()
    try {
      const view = await readWorkThread(db, subject)
      const turn = view.turns.find((t) => t.kind === 'reviewed')
      if (turn?.kind === 'reviewed') {
        expect(turn.commitSha).toBe('cafe1234')
        expect(turn.answer).toBe('Corrected it.')
      }
    } finally {
      db.close()
    }
  })

  test('an answer from an earlier turn keeps having no commit', async () => {
    // Disagreeing with a comment is an answer with no commit, and a later
    // turn's push must not make it look like something was changed for it.
    const { attachCommitToAnswers } = await import('@/modules/work/reviews')
    await recordReviewComments(subject, [comment('1', 'A matter of taste.')])
    await recordReviewAnswer(subject, {
      threadId: '1',
      answer: 'This should stand as it is.',
      commitSha: null,
      station: 'reviewer',
      at: '2026-10-09T10:00:00Z',
    })
    const attached = await attachCommitToAnswers(
      subject,
      'cafe1234',
      '2026-10-09T11:59:00Z',
    )
    expect(attached).toBe(0)
  })

  test('an answer that already names a commit is left alone', async () => {
    const { attachCommitToAnswers } = await import('@/modules/work/reviews')
    await recordReviewComments(subject, [comment('1', 'Off by one.')])
    await recordReviewAnswer(subject, {
      threadId: '1',
      answer: 'Fixed.',
      commitSha: 'aaa1111',
      station: 'reviewer',
      at: '2026-10-09T12:00:00Z',
    })
    expect(
      await attachCommitToAnswers(subject, 'bbb2222', '2026-10-09T11:00:00Z'),
    ).toBe(0)
  })
})
