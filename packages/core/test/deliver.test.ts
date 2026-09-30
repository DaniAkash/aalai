import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/modules/db/db'
import { answerGate, openGate } from '@/modules/gates'
import { deliverOutbox, releasedBy } from '@/modules/outbound/deliver'
import { queueDraftedReply } from '@/modules/outbound/drafted'
import type { RunRef, Subject } from '@/modules/work/paths'
import {
  claimDelivery,
  discardQueued,
  queueOutbound,
  readDelivery,
  readQueued,
} from '@/modules/work/store'

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
let existingComments: {
  id: number
  html_url: string
  body: string
  author: string
}[] = []
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
  authenticatedLogin: async () => 'the-maintainer',
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
        author: 'the-maintainer',
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

describe('what a classification drafts, and what a correction withdraws', () => {
  test('a drafted reply is queued so a person can release it', async () => {
    // Found by running a real question through a real repository: the report
    // carried a drafted reply, the gate was approved, and nothing was posted
    // because nothing had ever been queued.
    await queueDraftedReply(RUN, {
      classification: 'question',
      confidence: 'high',
      summary: 's',
      reasoning: 'r',
      affected_surface: [],
      missing: [],
      reply: 'Yes, it capitalises after the hyphen.',
    } as never)

    const queued = await readQueued(RUN)
    expect(queued.map((q) => q.intent.kind)).toEqual([
      'comment_on_issue',
      'close_issue',
    ])
    expect(queued[0]?.intent.body).toContain('after the hyphen')
  })

  test('a security report drafts nothing, whatever it wrote', async () => {
    await queueDraftedReply(RUN, {
      classification: 'security',
      confidence: 'high',
      summary: 's',
      reasoning: 'r',
      affected_surface: [],
      missing: [],
      reply: 'here is exactly how to exploit it',
    } as never)

    expect(await readQueued(RUN)).toHaveLength(0)
  })

  test('a bug drafts no comment and no close: it becomes work', async () => {
    await queueDraftedReply(RUN, {
      classification: 'bug',
      confidence: 'high',
      summary: 's',
      reasoning: 'r',
      affected_surface: [],
      missing: [],
      reply: 'we will look at this',
    } as never)

    expect(await readQueued(RUN)).toHaveLength(0)
  })

  test('correcting the classification withdraws what the wrong one drafted', async () => {
    // Otherwise the reply written for a question rides out on the gate that
    // approved the bug it was corrected into.
    await queueDraftedReply(RUN, {
      classification: 'question',
      confidence: 'high',
      summary: 's',
      reasoning: 'r',
      affected_surface: [],
      missing: [],
      reply: 'an answer to a question this was not',
    } as never)
    expect(await readQueued(RUN)).not.toHaveLength(0)

    await discardQueued(RUN)
    expect(await readQueued(RUN)).toHaveLength(0)
  })

  test('a withdrawal does not take back something already delivered', async () => {
    const gateId = openTriageGate()
    answer(gateId)
    await queueComment(gateId)
    const id = (await readQueued(RUN))[0]?.id ?? ''
    await deliver()

    const before = await readDelivery(RUN, id)
    expect(before).toBeDefined()
    await discardQueued(RUN)
    expect(await readDelivery(RUN, id)).toEqual(before)
  })
})

describe('the order things go out in', () => {
  test('the answer is posted before the issue is closed', async () => {
    // Both are queued in the same millisecond, so without a rule the order is
    // whatever the directory was read in, and an issue closes before the
    // reason for closing it has been said.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await discardQueued(RUN)
      await queueDraftedReply(RUN, {
        classification: 'duplicate',
        confidence: 'high',
        summary: 's',
        reasoning: 'r',
        affected_surface: [],
        missing: [],
        reply: 'already tracked in #12',
      } as never)
      const kinds = (await readQueued(RUN)).map((q) => q.intent.kind)
      expect(kinds).toEqual(['comment_on_issue', 'close_issue'])
    }
  })
})

describe('what counts as already said, and what a withdrawal spares', () => {
  test('somebody else saying the same words is not us having said them', async () => {
    // A reporter who quotes the draft back would otherwise be read as proof the
    // comment had gone out, and it would never be sent.
    existingComments = [
      {
        id: 1,
        html_url: 'https://example.invalid/1',
        body: 'thanks for reporting this',
        author: 'a-stranger',
      },
    ]
    const gateId = openTriageGate()
    answer(gateId)
    await queueComment(gateId)

    const report = await deliver()
    expect(report.delivered[0]?.source).toBe('sent')
  })

  test('our own identical comment is, so it is not posted twice', async () => {
    existingComments = [
      {
        id: 1,
        html_url: 'https://example.invalid/1',
        body: 'thanks for reporting this',
        author: 'the-maintainer',
      },
    ]
    const gateId = openTriageGate()
    answer(gateId)
    await queueComment(gateId)

    const report = await deliver()
    expect(report.delivered[0]?.url).toBe('https://example.invalid/1')
  })

  test('noise that still has a question in it is not closed either', async () => {
    // Found on a real run: a vague report came back as noise with four missing
    // details and a close queued behind it. Every classification can ask, so
    // the rule follows the question rather than the label.
    await queueDraftedReply(RUN, {
      classification: 'noise',
      confidence: 'high',
      summary: 's',
      reasoning: 'r',
      affected_surface: [],
      missing: ['the input', 'the output that was expected'],
      reply: 'What did you pass in, and what did you expect back?',
    } as never)

    expect((await readQueued(RUN)).map((q) => q.intent.kind)).toEqual([
      'comment_on_issue',
    ])
  })

  test('a question still missing its detail is not closed as it is asked', async () => {
    // It is about to wait weeks on the reporter. Queueing a close beside the
    // request would post the question and shut the issue in one go.
    await queueDraftedReply(RUN, {
      classification: 'question',
      confidence: 'high',
      summary: 's',
      reasoning: 'r',
      affected_surface: [],
      missing: ['the version it happens on'],
      reply: 'Which version are you on?',
    } as never)

    const kinds = (await readQueued(RUN)).map((q) => q.intent.kind)
    expect(kinds).toEqual(['comment_on_issue'])
  })

  test('a withdrawal leaves a delivered intent beside its record', async () => {
    const gateId = openTriageGate()
    answer(gateId)
    await queueComment(gateId)
    const id = (await readQueued(RUN))[0]?.id ?? ''
    await deliver()

    await discardQueued(RUN)
    expect(await readDelivery(RUN, id)).toBeDefined()
    // The intent itself survives too: the pair is the audit trail.
    expect((await readQueued(RUN)).map((q) => q.id)).toContain(id)
  })
})

describe('replaying a judgement does not say it twice', () => {
  test('queueing the same generation again rewrites rather than adds', async () => {
    // The queue sits outside the attempt's durable outcome, so a crash between
    // writing these and persisting the transition replays this call. A random
    // name would make that a second public comment.
    const verdict = {
      classification: 'question',
      confidence: 'high',
      summary: 's',
      reasoning: 'r',
      affected_surface: [],
      missing: [],
      reply: 'the answer',
    } as never

    await queueDraftedReply(RUN, verdict, 1)
    await queueDraftedReply(RUN, verdict, 1)

    expect(await readQueued(RUN)).toHaveLength(2)
  })

  test('a genuinely new judgement queues its own', async () => {
    const verdict = {
      classification: 'question',
      confidence: 'high',
      summary: 's',
      reasoning: 'r',
      affected_surface: [],
      missing: [],
      reply: 'the answer',
    } as never

    await queueDraftedReply(RUN, verdict, 1)
    await queueDraftedReply(RUN, verdict, 2)

    expect(await readQueued(RUN)).toHaveLength(4)
  })
})

describe('two workers cannot both say it', () => {
  test('only one of them gets to send', async () => {
    // The gate check, the delivery-record check and the look for an existing
    // comment are all reads. Two workers pass them together and both post,
    // which is a duplicate comment under a maintainer's name in public.
    const gateId = openTriageGate()
    answer(gateId)
    await queueComment(gateId)
    const id = (await readQueued(RUN))[0]?.id ?? ''

    expect(await claimDelivery(RUN, id)).toBe(true)
    expect(await claimDelivery(RUN, id)).toBe(false)
  })

  test('a claimed intent is left alone rather than sent again', async () => {
    const gateId = openTriageGate()
    answer(gateId)
    await queueComment(gateId)
    const id = (await readQueued(RUN))[0]?.id ?? ''
    await claimDelivery(RUN, id)

    const report = await deliver()
    expect(posted).toHaveLength(0)
    expect(report.refused[0]?.refusal.kind).toBe('in_flight')
  })

  test('a failed send hands the claim back so it can be retried', async () => {
    const gateId = openTriageGate()
    answer(gateId)
    await queueComment(gateId)
    const id = (await readQueued(RUN))[0]?.id ?? ''

    postShouldFail = true
    await deliver()
    postShouldFail = false

    // Claimable again, which is what lets a later pass pick it up.
    expect(await claimDelivery(RUN, id)).toBe(true)
  })
})
