import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listGates, readGate } from '@/modules/gates/gates'
import {
  recordReviewAnswer,
  recordReviewComments,
} from '@/modules/work/reviews'
import { openReviewRelease } from '@/run/reviewRelease'
import { openState } from '@/watch/state'

const subject = {
  repo: 'DaniAkash/aalai-demo',
  kind: 'issue' as const,
  number: 68,
}
const run = { subject, runId: 'DaniAkash/aalai-demo#68@1790000000068' }

let home: string
let previous: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'aalai-release-'))
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

async function answer(id: string, text: string, at = '2026-10-10T10:00:00Z') {
  await recordReviewComments(subject, [
    {
      id,
      author: 'Copilot',
      body: `comment ${id}`,
      path: 'src/x.ts',
      line: 1,
      at,
    },
  ])
  await recordReviewAnswer(subject, {
    threadId: id,
    answer: text,
    commitSha: null,
    station: 'reviewer',
    at,
  })
}

describe('one gate for one review', () => {
  test('every unsent answer is on the same gate', async () => {
    const db = openState()
    try {
      await answer('1', 'Corrected the comparison.')
      await answer('2', 'This should stand as it is.')
      await answer('3', 'Added the test.')
      const release = await openReviewRelease(db, run, 0)
      expect(release?.answers).toHaveLength(3)
      expect(readGate(db, release?.gateId ?? '')?.status).toBe('open')
    } finally {
      db.close()
    }
  })

  test('nothing to send opens no gate', async () => {
    // A review nobody has answered yet must not put a question in the inbox
    // that has nothing in it.
    const db = openState()
    try {
      expect(await openReviewRelease(db, run, 0)).toBeUndefined()
      expect(listGates(db, { runId: run.runId })).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  test('the summary says how many and what they say', async () => {
    // An inbox row reading only "replies are ready" makes a person open it to
    // find out whether it is worth opening.
    const db = openState()
    try {
      await answer('1', 'Corrected the comparison in the unit loop.')
      await answer('2', 'This should stand.')
      const release = await openReviewRelease(db, run, 0)
      const summary = readGate(db, release?.gateId ?? '')?.summary ?? ''
      expect(summary).toContain('2 replies')
      expect(summary).toContain('Corrected the comparison')
    } finally {
      db.close()
    }
  })

  test('a comment arriving mid gate supersedes the old question', async () => {
    // Approving the old gate would post answers to some comments and silently
    // ignore the ones that arrived after it was asked.
    const db = openState()
    try {
      await answer('1', 'First answer.')
      const first = await openReviewRelease(db, run, 0)
      await answer('2', 'Answer to what arrived later.')
      const second = await openReviewRelease(db, run, 1)

      expect(second?.gateId).not.toBe(first?.gateId)
      expect(readGate(db, first?.gateId ?? '')?.status).toBe('superseded')
      expect(readGate(db, second?.gateId ?? '')?.status).toBe('open')
      expect(second?.answers).toHaveLength(2)
    } finally {
      db.close()
    }
  })

  test('the generation is part of the gate identity', async () => {
    // Without it the second question reuses the first id, and answering the
    // old one answers the new one.
    const db = openState()
    try {
      await answer('1', 'First answer.')
      const first = await openReviewRelease(db, run, 0)
      const second = await openReviewRelease(db, run, 1)
      expect(first?.gateId).toContain(':review_reply:0')
      expect(second?.gateId).toContain(':review_reply:1')
    } finally {
      db.close()
    }
  })
})
