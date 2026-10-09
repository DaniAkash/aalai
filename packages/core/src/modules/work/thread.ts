import type { Database } from 'bun:sqlite'
import { stat } from 'node:fs/promises'
import type { StationId } from '@/events/events.types'
import type { GateRow } from '@/modules/db/schema/schema'
import { listGatesForSubject } from '@/modules/gates/gates'
import {
  findArtifacts,
  latestArtifact,
  readArtifact,
} from '@/modules/work/artifacts'
import { readConversation } from '@/modules/work/conversation'
import type { Subject } from '@/modules/work/paths'
import {
  type RecordedAnswer,
  type RecordedComment,
  readReviewRecords,
} from '@/modules/work/reviews'
import { stationName } from '@/shared/stepActivity'
import type { ThreadView, Turn } from '@/shared/threadView'

/**
 * Everything that happened to one subject, in the order it happened.
 *
 * Three sources with nothing in common but a timestamp: a markdown file of
 * conversation entries, a directory of versioned artifacts, and rows in the
 * gate table. Merging them is this module's whole job, and it lives next to the
 * things being merged rather than in the route, so it can be tested without a
 * server.
 */
export async function readWorkThread(
  db: Database,
  subject: Subject,
): Promise<ThreadView> {
  const [said, recorded, reviewed, plan] = await Promise.all([
    saidTurns(subject),
    recordedTurns(subject),
    reviewTurns(subject),
    latestPlan(subject),
  ])
  const gates = gateTurns(db, subject)

  const turns = [...said, ...recorded, ...reviewed, ...gates].sort(byTime)
  const open = gates.find(
    (turn) => turn.kind === 'gate' && turn.status === 'open',
  )

  return {
    turns,
    plan,
    awaiting:
      open === undefined || open.kind !== 'gate'
        ? null
        : {
            gateId: open.gateId,
            kind: open.gateKind,
            summary: open.summary,
            artifact: open.artifact,
            artifactVersion: open.artifactVersion,
          },
  }
}

/**
 * Oldest first, and ties broken by id.
 *
 * Compared as instants rather than as strings, because the sources do not
 * agree on a format: conversation entries and artifacts carry ISO timestamps
 * while gate rows written by the database default carry `YYYY-MM-DD HH:MM:SS`.
 * A space sorts before `T`, so comparing the text puts every such gate ahead
 * of everything else that happened the same day.
 *
 * Ties go to the id. A gate opened by the same write that recorded the
 * artifact it points at can share a second, and a thread that reorders itself
 * between two refetches reads as though something happened.
 */
function byTime(a: Turn, b: Turn): number {
  return instant(a.at) - instant(b.at) || a.id.localeCompare(b.id)
}

function instant(at: string): number {
  const direct = Date.parse(at)
  if (!Number.isNaN(direct)) {
    return direct
  }
  // SQLite's `current_timestamp` is UTC without saying so, and parsing it as
  // local time would move those rows by the offset.
  const utc = Date.parse(`${at.replace(' ', 'T')}Z`)
  return Number.isNaN(utc) ? 0 : utc
}

/**
 * What was said, keeping the order it was said in.
 *
 * Two entries written in the same millisecond are common: a station records
 * its note and a person replies within the same tick of a seeded thread, and
 * agents write in bursts. The merge breaks ties on the id, so the position in
 * the file is encoded into it. Without that, equal timestamps sort
 * alphabetically by author and a reply can appear above the thing it answers.
 */
/**
 * What the review said, and what was said back.
 *
 * Each comment becomes one turn carrying its answer, rather than a turn each.
 * The answer is found by the comment id the station was given, so an answer
 * whose comment was never recorded is dropped: showing an answer with nothing
 * to answer reads as a bug rather than as history.
 */
async function reviewTurns(subject: Subject): Promise<Turn[]> {
  const records = await readReviewRecords(subject)
  const answers = new Map<string, RecordedAnswer>()
  for (const record of records) {
    if (record.kind === 'answer') {
      // The last answer wins. A comment reopened and answered again should
      // read as the answer that stands, not the first one given.
      answers.set(record.threadId, record)
    }
  }
  return records
    .filter((record): record is RecordedComment => record.kind === 'comment')
    .map((comment, index): Turn => {
      const answer = answers.get(comment.id)
      return {
        kind: 'reviewed',
        id: `reviewed:${String(index).padStart(6, '0')}:${comment.id}`,
        at: comment.at,
        voice: 'reporter',
        author: comment.author,
        commentId: comment.id,
        body: comment.body,
        path: comment.path,
        line: comment.line,
        answer: answer?.answer ?? null,
        answeredAt: answer?.at ?? null,
        commitSha: answer?.commitSha ?? null,
      }
    })
}

async function saidTurns(subject: Subject): Promise<Turn[]> {
  const entries = await readConversation(subject)
  return entries.map(
    (entry, index): Turn => ({
      kind: 'said',
      id: `said:${String(index).padStart(6, '0')}:${entry.id}`,
      at: entry.at,
      voice: entry.role,
      author: bylineFor(entry.role, entry.author),
      body: entry.body,
    }),
  )
}

/**
 * What the stations wrote down, timed by the file they wrote.
 *
 * An artifact carries its version in its name and nothing else, so the moment
 * it was recorded has to come from the filesystem. A file that cannot be
 * stat'ed is dropped rather than given a guessed time: a turn in the wrong
 * place in the thread is worse than a turn that is missing.
 */
async function recordedTurns(subject: Subject): Promise<Turn[]> {
  const refs = await findArtifacts({ subject })
  const turns = await Promise.all(
    refs.map(async (ref): Promise<Turn | undefined> => {
      const at = await writtenAt(ref.path)
      return at === undefined
        ? undefined
        : {
            kind: 'recorded',
            id: `artifact:${ref.id}`,
            at,
            voice: 'station',
            author: authorOf(ref.kind),
            artifact: ref.id,
            artifactKind: ref.kind,
            version: ref.version,
          }
    }),
  )
  return turns.filter((turn): turn is Turn => turn !== undefined)
}

async function writtenAt(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).mtime.toISOString()
  } catch {
    return undefined
  }
}

/** Which station records each kind, so a turn has a byline. */
/**
 * A byline, from what the conversation file recorded.
 *
 * The file stores the station id, which is right: it is the durable name and
 * it does not change when the interface does. The display name is derived
 * here, so existing conversations read correctly without being rewritten.
 * A person's own handle is left exactly as they wrote it.
 */
function bylineFor(role: string, author: string): string {
  return role === 'station' && isStation(author) ? stationName(author) : author
}

const STATIONS = ['classifier', 'analyst', 'implementer', 'reviewer'] as const

function isStation(author: string): author is StationId {
  return (STATIONS as readonly string[]).includes(author)
}

/**
 * Who to credit for an artifact, named as a byline names a person.
 *
 * The same display names the rest of the interface uses, because a byline
 * reading "analyst" beside one reading "Implementer is working" looks like a
 * bug in one of them.
 */
function authorOf(kind: string): string {
  switch (kind) {
    case 'plan':
    case 'criteria':
      return stationName('analyst')
    case 'review':
      return stationName('reviewer')
    case 'triage':
      return stationName('classifier')
    default:
      return 'Station'
  }
}

function gateTurns(db: Database, subject: Subject): Turn[] {
  return listGatesForSubject(db, subject).map(
    (gate: GateRow): Turn => ({
      kind: 'gate',
      id: `gate:${gate.id}`,
      // A gate that has been answered belongs where the answer happened, not
      // where the question did: the question is already in the thread as the
      // artifact it points at.
      at: gate.answeredAt ?? gate.openedAt,
      voice: 'system',
      author: gate.answeredBy ?? 'aalai',
      gateId: gate.id,
      gateKind: gate.kind,
      status: gate.status,
      decision: gate.decision,
      summary: gate.summary,
      artifact: gate.artifactPath,
      artifactVersion: gate.artifactVersion,
    }),
  )
}

async function latestPlan(subject: Subject): Promise<ThreadView['plan']> {
  const ref = await latestArtifact(subject, 'plan')
  if (ref === undefined) {
    return null
  }
  const body = await readArtifact(ref.id)
  return body === undefined
    ? null
    : { artifact: ref.id, version: ref.version, body }
}
