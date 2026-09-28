import type { Database } from 'bun:sqlite'
import { emit } from '@/events/bus'
import type { ConversationEntry } from '@/modules/work/conversation'
import { appendEntry, readConversation } from '@/modules/work/conversation'
import type { RunRef, Subject } from '@/modules/work/paths'
import { readSnapshot } from '@/run/machines/snapshots'
import { gateActivity } from '@/run/machines/types'
import { parseRunId } from '@/watch/resume'
import { readGate } from './gates'

/**
 * The discussion attached to a gate.
 *
 * The thread is the subject's conversation rather than the gate's, because a
 * subject outlives its runs: the negotiation that shaped a plan is still the
 * relevant history when a later run reopens the same issue. A gate is the window
 * you are looking through, not the thing being discussed.
 */
export interface ThreadView {
  readonly entries: readonly ConversationEntry[]
  /**
   * Whether a station is mid answer.
   *
   * Read from the snapshot on disk rather than from `machine_snapshots.value`,
   * because the substate is deliberately kept out of that column: it is queried
   * to decide what to resume, and a detail view can afford one file read.
   */
  readonly state: 'idle' | 'answering'
}

/** The subject a gate belongs to, from the run that opened it. */
export function gateSubject(runId: string): Subject | undefined {
  const parsed = parseRunId(runId)
  return parsed === undefined
    ? undefined
    : { repo: parsed.repo, kind: 'issue', number: parsed.issueNumber }
}

export async function readThread(
  db: Database,
  gateId: string,
): Promise<ThreadView | undefined> {
  const gate = readGate(db, gateId)
  if (gate === undefined) {
    return undefined
  }
  const subject = gateSubject(gate.runId)
  if (subject === undefined) {
    return undefined
  }
  const run: RunRef = { subject, runId: gate.runId }
  const [entries, snapshot] = await Promise.all([
    readConversation(subject),
    readSnapshot(run),
  ])
  const value = (snapshot as { value?: unknown } | undefined)?.value
  return {
    entries,
    state: gateActivity(value) === 'answering' ? 'answering' : 'idle',
  }
}

/** Why a reply did not take. */
export type ReplyRefusal =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_open'; readonly status: string }
  | { readonly kind: 'wrong_kind'; readonly kind_was: string }

export type ReplyResult =
  | { readonly ok: true; readonly entry: ConversationEntry }
  | { readonly ok: false; readonly refusal: ReplyRefusal }

/**
 * Says something at a gate without answering it.
 *
 * Refuses rather than throws, the same way answering does: a person can be
 * mid reply while someone else approves, and that race is expected.
 *
 * Only a plan gate takes a reply. A permission ask holds an agent turn open and
 * dies with the process, so a conversation cannot fit inside one.
 */
export async function replyToGate(
  db: Database,
  input: { gateId: string; body: string; author: string },
): Promise<ReplyResult> {
  const gate = readGate(db, input.gateId)
  if (gate === undefined) {
    return { ok: false, refusal: { kind: 'not_found' } }
  }
  if (gate.kind !== 'plan') {
    return { ok: false, refusal: { kind: 'wrong_kind', kind_was: gate.kind } }
  }
  if (gate.status !== 'open') {
    return { ok: false, refusal: { kind: 'not_open', status: gate.status } }
  }
  const subject = gateSubject(gate.runId)
  if (subject === undefined) {
    return { ok: false, refusal: { kind: 'not_found' } }
  }
  const entry = await appendEntry(subject, {
    author: input.author,
    role: 'maintainer',
    body: input.body,
  })
  emit({
    type: 'conversation.appended',
    runId: gate.runId,
    gateId: gate.id,
    author: entry.author,
    role: entry.role,
    at: Date.now(),
  })
  return { ok: true, entry }
}
