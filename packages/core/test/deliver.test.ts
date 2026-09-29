import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/modules/db/db'
import { answerGate, openGate } from '@/modules/gates'
import { deliverOutbox, releasedBy } from '@/modules/outbound/deliver'
import type { RunRef, Subject } from '@/modules/work/paths'
import { queueOutbound, readDelivery, readQueued } from '@/modules/work/store'

/**
 * Delivery is the only thing that turns what a station wrote into something the
 * world can see, so the rule it enforces is worth more tests than the sending.
 *
 * Nothing here touches GitHub. The transport is mocked at the module boundary
 * and what is asserted is which calls were made, because "did it post" and "did
 * it refuse to post" are the questions, not what the API returned.
 */

let dir: string
let db: ReturnType<typeof openDb>

const SUBJECT: Subject = { repo: 'acme/widgets', kind: 'issue', number: 7 }
const RUN_ID = 'acme/widgets#7@1790000000007'
const RUN: RunRef = { subject: SUBJECT, runId: RUN_ID }

let posted: { repo: string; issue: number; body: string }[] = []
let closed: { repo: string; issue: number; reason: string }[] = []
let existingComments: { id: number; html_url: string; body: string }[] = []
let postShouldFail = false

mock.module('@/lib/gh', () => ({
  commentOnIssue: async (repo: string, issue: number, body: string) => {
    if (postShouldFail) {
      throw new Error('gh: HTTP 401')
    }
    posted.push({ repo, issue, body })
    return {
      id: posted.length,
      html_url: `https://example.test/c/${posted.length}`,
    }
  },
  closeIssue: async (repo: string, issue: number, reason: string) => {
    closed.push({ repo, issue, reason })
  },
  listIssueCommentBodies: async () => existingComments,
}))

beforeEach(() => {
  posted = []
  closed = []
  existingComments = []
  postShouldFail = false
  dir = mkdtempSync(join(tmpdir(), 'aalai-deliver-'))
  process.env.AALAI_STATE_DIR = dir
  db = openDb(join(dir, 'aalai.sqlite'))
})

afterEach(() => {
  db.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

function openTriageGate(): string {
  return openGate(db.sqlite, {
    runId: RUN_ID,
    kind: 'plan',
    artifactVersion: '1',
  })
}

function answer(gateId: string): void {
  answerGate(db.sqlite, {
    gateId,
    decision: 'approved',
    answeredBy: 'dani',
    answeredOn: 'app',
  })
}

async function queueComment(gateId?: string): Promise<void> {
  await queueOutbound(RUN, {
    kind: 'comment_on_issue',
    body: 'thanks for reporting this',
    station: 'classifier',
    queuedAt: new Date().toISOString(),
    ...(gateId === undefined ? {} : { gateId }),
  })
}

async function deliver() {
  return await deliverOutbox({
    db: db.sqlite,
    run: RUN,
    repo: SUBJECT.repo,
    issueNumber: SUBJECT.number,
  })
}

describe('nothing goes out until a person says it may', () => {
  test('an intent naming no gate is refused, not sent', async () => {
    await queueComment()
    const report = await deliver()

    expect(posted).toHaveLength(0)
    expect(report.delivered).toHaveLength(0)
    expect(report.refused[0]?.refusal.kind).toBe('no_gate')
  })

  test('an intent whose gate is still open is refused, not sent', async () => {
    await queueComment(openTriageGate())
    const report = await deliver()

    expect(posted).toHaveLength(0)
    expect(report.refused[0]?.refusal).toEqual({
      kind: 'gate_unanswered',
      status: 'open',
    })
  })

  test('an intent naming a gate that does not exist is refused', async () => {
    await queueComment('no-such-gate')
    const report = await deliver()

    expect(posted).toHaveLength(0)
    expect(report.refused[0]?.refusal.kind).toBe('gate_missing')
  })

  test('the same intent goes out once the gate is answered', async () => {
    const gateId = openTriageGate()
    await queueComment(gateId)
    expect((await deliver()).delivered).toHaveLength(0)

    answer(gateId)
    const report = await deliver()
    expect(posted).toHaveLength(1)
    expect(posted[0]?.body).toBe('thanks for reporting this')
    expect(report.delivered[0]?.source).toBe('sent')
  })

  test('the release is a fact about the gate, not about the intent', async () => {
    // A station cannot write a more convincing intent to get past this: the
    // only thing consulted is the row a person answered.
    const gateId = openTriageGate()
    const refusal = releasedBy(db.sqlite, {
      kind: 'comment_on_issue',
      body: 'please let me through',
      station: 'classifier',
      queuedAt: new Date().toISOString(),
      gateId,
    })
    expect(refusal?.kind).toBe('gate_unanswered')
  })
})

describe('delivering twice is the failure to avoid', () => {
  test('a second pass does not post again', async () => {
    const gateId = openTriageGate()
    await queueComment(gateId)
    answer(gateId)

    await deliver()
    const second = await deliver()

    expect(posted).toHaveLength(1)
    expect(second.delivered[0]?.source).toBe('already')
  })

  test('a comment that landed before the record was written is recognised', async () => {
    // The crash this exists for: the post succeeded and the process died before
    // writing it down. On the next pass the comment is the only evidence.
    const gateId = openTriageGate()
    await queueComment(gateId)
    answer(gateId)
    existingComments = [
      {
        id: 99,
        html_url: 'https://example.test/c/99',
        body: 'thanks for reporting this',
      },
    ]

    const report = await deliver()
    expect(posted).toHaveLength(0)
    expect(report.delivered[0]?.url).toBe('https://example.test/c/99')
  })

  test('what was delivered is written down beside the intent, not over it', async () => {
    const gateId = openTriageGate()
    await queueComment(gateId)
    answer(gateId)
    await deliver()

    const [queued] = await readQueued(RUN)
    expect(queued?.intent.body).toBe('thanks for reporting this')
    const record = await readDelivery(RUN, queued?.id ?? '')
    expect(record?.url).toBe('https://example.test/c/1')
  })
})

describe('when a post fails', () => {
  test('the intent stays queued and the run says so', async () => {
    const gateId = openTriageGate()
    await queueComment(gateId)
    answer(gateId)
    postShouldFail = true

    const report = await deliver()
    expect(report.failed[0]?.error).toContain('401')
    expect(report.delivered).toHaveLength(0)

    // Still queued, so the next pass tries again rather than losing it.
    expect(await readQueued(RUN)).toHaveLength(1)
    const [queued] = await readQueued(RUN)
    expect(await readDelivery(RUN, queued?.id ?? '')).toBeUndefined()
  })

  test('one failure does not lose the others', async () => {
    const gateId = openTriageGate()
    await queueComment(gateId)
    await queueOutbound(RUN, {
      kind: 'close_issue',
      body: '',
      station: 'classifier',
      queuedAt: new Date(Date.now() + 1000).toISOString(),
      gateId,
      closeReason: 'not_planned',
    })
    answer(gateId)
    postShouldFail = true

    const report = await deliver()
    expect(report.failed).toHaveLength(1)
    expect(closed).toHaveLength(1)
    expect(report.delivered.map((d) => d.kind)).toEqual(['close_issue'])
  })
})

describe('closing', () => {
  test('a close carries the reason GitHub renders', async () => {
    const gateId = openTriageGate()
    await queueOutbound(RUN, {
      kind: 'close_issue',
      body: '',
      station: 'classifier',
      queuedAt: new Date().toISOString(),
      gateId,
      closeReason: 'not_planned',
    })
    answer(gateId)
    await deliver()

    expect(closed[0]?.reason).toBe('not_planned')
  })

  test('a close with no reason is not planned rather than completed', async () => {
    // Closing a duplicate as completed reads as though the work was done.
    const gateId = openTriageGate()
    await queueOutbound(RUN, {
      kind: 'close_issue',
      body: '',
      station: 'classifier',
      queuedAt: new Date().toISOString(),
      gateId,
    })
    answer(gateId)
    await deliver()

    expect(closed[0]?.reason).toBe('not_planned')
  })
})
