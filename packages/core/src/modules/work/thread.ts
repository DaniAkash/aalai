import type { Database } from 'bun:sqlite'
import { stat } from 'node:fs/promises'
import type { GateRow } from '@/modules/db/schema/schema'
import { listGatesForSubject } from '@/modules/gates/gates'
import {
  findArtifacts,
  latestArtifact,
  readArtifact,
} from '@/modules/work/artifacts'
import { readConversation } from '@/modules/work/conversation'
import type { Subject } from '@/modules/work/paths'
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
  const [said, recorded, plan] = await Promise.all([
    saidTurns(subject),
    recordedTurns(subject),
    latestPlan(subject),
  ])
  const gates = gateTurns(db, subject)

  const turns = [...said, ...recorded, ...gates].sort(byTime)
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
 * A gate opened by the same write that recorded the artifact it points at can
 * share a timestamp to the second, and a thread that reorders itself between
 * two refetches reads as though something happened.
 */
function byTime(a: Turn, b: Turn): number {
  return a.at.localeCompare(b.at) || a.id.localeCompare(b.id)
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
async function saidTurns(subject: Subject): Promise<Turn[]> {
  const entries = await readConversation(subject)
  return entries.map(
    (entry, index): Turn => ({
      kind: 'said',
      id: `said:${String(index).padStart(6, '0')}:${entry.id}`,
      at: entry.at,
      voice: entry.role,
      author: entry.author,
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
function authorOf(kind: string): string {
  switch (kind) {
    case 'plan':
    case 'criteria':
      return 'analyst'
    case 'review':
      return 'reviewer'
    case 'triage':
      return 'classifier'
    default:
      return 'station'
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
