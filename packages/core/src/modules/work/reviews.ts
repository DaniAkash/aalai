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
}

export type ReviewRecord = RecordedComment | RecordedAnswer

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
