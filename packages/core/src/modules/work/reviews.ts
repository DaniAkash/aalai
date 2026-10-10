import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '@/lib/log'
import type { Subject } from '@/modules/work/paths'
import { subjectDir } from '@/modules/work/paths'

/**
 * What a review said, and what the factory said back.
 *
 * One append only file per subject holding both sides, because a comment and
 * its answer are one conversation and splitting them across two stores would
 * leave every reader to join them.
 *
 * The comments are GitHub's, and GitHub stays the owner: this is a record of
 * what the watcher observed, so that opening a thread is not a rate limited
 * network call. The answers have no other home at all. They were going to the
 * per turn grant, which is revoked, and to an event, which dies with the
 * process, so neither survived long enough for a person to read.
 */

const log = logger('reviews')
const FILE = 'reviews.jsonl'

/** A comment as it was written down here, distinct from GitHub's wire shape. */
export interface RecordedComment {
  readonly kind: 'comment'
  /** GitHub's comment id, which is also what an answer refers to. */
  readonly id: string
  readonly author: string
  readonly body: string
  readonly path: string | null
  readonly line: number | null
  readonly at: string
}

export interface RecordedAnswer {
  readonly kind: 'answer'
  /** The comment this answers, as the station was given it. */
  readonly threadId: string
  readonly answer: string
  /** The commit that addressed it, when there was one. */
  readonly commitSha: string | null
  readonly station: string
  readonly at: string
  /**
   * When this reached the reviewer, and where it landed.
   *
   * Written by delivery rather than by the station, because the station does
   * not post and must not be able to say that it did. Null means recorded and
   * not sent, which is every answer until a person releases it.
   */
  readonly postedAt?: string | null
  readonly postedUrl?: string | null
  /** When the thread was closed on GitHub. A summary has none to close. */
  readonly resolvedAt?: string | null
  /** Why it could not be sent, when it could not. */
  readonly failed?: string | null
}

export type ReviewRecord = RecordedComment | RecordedAnswer

/**
 * What a reviewer wrote, as a person reads it.
 *
 * Three things come out, none of which anybody said. HTML comments are a
 * handle for the bot that left them. HTML tags are markup this interface does
 * not render, so `<details>` and a link element would otherwise appear as
 * themselves in the middle of a sentence; the text inside them is kept,
 * because that is the part somebody wrote. Runs of blank lines left behind by
 * the first two are collapsed.
 *
 * What is deliberately not done here is shortening it. A review is as long as
 * the reviewer made it, and cutting it would hide the part they cared about.
 */
export function readableReviewBody(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function fileFor(subject: Subject): string {
  return join(subjectDir(subject), FILE)
}

/**
 * Everything recorded about this subject's review, in the order it happened.
 *
 * A line that will not parse is skipped rather than throwing. The file is
 * append only and written by two different paths, so a torn write should cost
 * one record and not the whole history.
 */
export async function readReviewRecords(
  subject: Subject,
): Promise<ReviewRecord[]> {
  const file = Bun.file(fileFor(subject))
  if (!(await file.exists())) {
    return []
  }
  const out: ReviewRecord[] = []
  for (const line of (await file.text()).split('\n')) {
    if (line.trim() === '') {
      continue
    }
    try {
      out.push(JSON.parse(line) as ReviewRecord)
    } catch {
      log.debug('skipped an unreadable review record', {
        subject: subject.repo,
      })
    }
  }
  return out
}

async function append(subject: Subject, record: ReviewRecord): Promise<void> {
  const dir = subjectDir(subject)
  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, FILE), `${JSON.stringify(record)}\n`)
}

/**
 * Records comments the watcher has seen, skipping the ones already recorded.
 *
 * The watcher sees every comment on every poll, so this is called repeatedly
 * with mostly the same list. Returns what was new, so a caller can tell
 * whether anything actually happened.
 */
export async function recordReviewComments(
  subject: Subject,
  comments: readonly Omit<RecordedComment, 'kind'>[],
): Promise<RecordedComment[]> {
  const known = new Set(
    (await readReviewRecords(subject))
      .filter((record): record is RecordedComment => record.kind === 'comment')
      .map((record) => record.id),
  )
  const added: RecordedComment[] = []
  for (const comment of comments) {
    if (known.has(comment.id)) {
      continue
    }
    const record: RecordedComment = { ...comment, kind: 'comment' }
    await append(subject, record)
    known.add(comment.id)
    added.push(record)
  }
  return added
}

export async function recordReviewAnswer(
  subject: Subject,
  answer: Omit<RecordedAnswer, 'kind'>,
): Promise<void> {
  await append(subject, { ...answer, kind: 'answer' })
}

/**
 * Attaches a commit to answers that were given without one.
 *
 * The station answers during its turn and the commit is made after it, so the
 * sha does not exist while the answers are being written. Rather than mutate
 * the file, the answers are written again carrying it: the store is append
 * only and the last answer for a comment is the one that stands, so this reads
 * back as the answer having had a commit all along.
 *
 * Only answers given in this turn are touched, identified by the ones that
 * have no commit yet, so an earlier answer that genuinely had none keeps it.
 */
export async function attachCommitToAnswers(
  subject: Subject,
  commitSha: string,
  since: string,
): Promise<number> {
  const records = await readReviewRecords(subject)
  const latest = new Map<string, RecordedAnswer>()
  for (const record of records) {
    if (record.kind === 'answer') {
      latest.set(record.threadId, record)
    }
  }
  let attached = 0
  for (const answer of latest.values()) {
    if (answer.commitSha !== null || answer.at < since) {
      continue
    }
    await append(subject, { ...answer, commitSha })
    attached += 1
  }
  return attached
}

/**
 * Records what delivery did with one answer.
 *
 * Appended rather than edited, like the commit attachment: the store is append
 * only and the last answer for a comment is the one that stands, so this reads
 * back as the answer having been sent all along.
 */
export async function markAnswerDelivered(
  subject: Subject,
  threadId: string,
  outcome: {
    readonly postedAt?: string
    readonly postedUrl?: string
    readonly resolvedAt?: string
    readonly failed?: string
  },
): Promise<void> {
  const answer = (await readReviewRecords(subject))
    .filter((record): record is RecordedAnswer => record.kind === 'answer')
    .filter((record) => record.threadId === threadId)
    .at(-1)
  if (answer === undefined) {
    return
  }
  await append(subject, { ...answer, ...outcome })
}

/** The answers on this subject that have not reached the reviewer yet. */
export async function unsentAnswers(
  subject: Subject,
): Promise<RecordedAnswer[]> {
  const latest = new Map<string, RecordedAnswer>()
  for (const record of await readReviewRecords(subject)) {
    if (record.kind === 'answer') {
      latest.set(record.threadId, record)
    }
  }
  return [...latest.values()].filter(
    (answer) => answer.postedAt === undefined || answer.postedAt === null,
  )
}
