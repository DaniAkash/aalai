import type { Database } from 'bun:sqlite'
import { and, asc, eq } from 'drizzle-orm'
import { query } from '@/modules/db/query'
import {
  type GateRow,
  type GateStatus,
  gates,
} from '@/modules/db/schema/schema'
import { publishGateAnswered } from './bus'
import type {
  AnswerGateInput,
  AnswerRefusal,
  AnswerResult,
  GateQuery,
  OpenGateInput,
} from './gates.types'

/**
 * Opens a gate and returns its id.
 *
 * Deterministic in the run and the kind so a machine that re-enters the state
 * after a restart adopts the gate it already opened rather than opening a
 * second one a person would have to answer twice.
 */
export function openGate(db: Database, input: OpenGateInput): string {
  const id = gateId(input)
  query(db)
    .insert(gates)
    .values({
      id,
      runId: input.runId,
      kind: input.kind,
      status: 'open',
      artifactPath: input.artifactPath ?? null,
      artifactVersion: input.artifactVersion ?? null,
      summary: input.summary ?? null,
    })
    .onConflictDoNothing()
    .run()
  return id
}

export function gateId(input: {
  runId: string
  kind: string
  artifactVersion?: string
  /** Set when the question has no artifact to pin it, so it needs its own. */
  nonce?: string
}): string {
  // The version is part of the identity because a gate on v2 is a different
  // question from the one asked about v1, and answering the old one must not
  // answer the new one.
  const discriminator = input.nonce ?? input.artifactVersion ?? '0'
  return `${input.runId}:${input.kind}:${discriminator}`
}

export function readGate(db: Database, id: string): GateRow | undefined {
  return query(db).select().from(gates).where(eq(gates.id, id)).get()
}

export function listGates(db: Database, filter: GateQuery = {}): GateRow[] {
  const where = [
    ...(filter.status === undefined ? [] : [eq(gates.status, filter.status)]),
    ...(filter.runId === undefined ? [] : [eq(gates.runId, filter.runId)]),
  ]
  return (
    query(db)
      .select()
      .from(gates)
      .where(where.length === 0 ? undefined : and(...where))
      // Oldest first. This is an inbox, and the thing that has waited longest is
      // the thing most likely to be blocking somebody.
      .orderBy(asc(gates.openedAt))
      .limit(filter.limit ?? 100)
      .all()
  )
}

/**
 * Records a decision, or says why it did not take.
 *
 * The only writer of a decision, so the rules below hold no matter which
 * surface is asking. Written in one transaction with the status check inside
 * it, because two surfaces answering at the same moment is the expected case
 * rather than the rare one, and a check outside the write is a race.
 */
export function answerGate(db: Database, input: AnswerGateInput): AnswerResult {
  const result = record(db, input)
  // Published after the commit, never inside it. A listener told about an
  // answer that a rolled back transaction never wrote would act on a decision
  // nobody made.
  if (result.ok) {
    publishGateAnswered(result.gate)
  }
  return result
}

function record(db: Database, input: AnswerGateInput): AnswerResult {
  return db.transaction(() => {
    const gate = readGate(db, input.gateId)
    if (gate === undefined) {
      return { ok: false, refusal: { kind: 'not_found' } } as const
    }
    // Only `open` is answerable. Listing the terminal states individually is
    // what let `expired` slip through the first time, so the check is now on
    // the one state that may be written rather than on the ones that may not.
    if (gate.status !== 'open') {
      return { ok: false, refusal: refusalFor(gate) } as const
    }
    query(db)
      .update(gates)
      .set({
        status: 'answered',
        decision: input.decision,
        reason: input.reason ?? null,
        answeredBy: input.answeredBy,
        answeredOn: input.answeredOn,
        answeredAt: new Date().toISOString(),
      })
      .where(eq(gates.id, input.gateId))
      .run()
    const answered = readGate(db, input.gateId)
    if (answered === undefined) {
      return { ok: false, refusal: { kind: 'not_found' } } as const
    }
    return { ok: true, gate: answered } as const
  })()
}

/**
 * Retires every open gate on a run, because the artifact moved under them.
 *
 * Called when a station writes a new version. An approval pins to the bytes it
 * was given, so a gate opened on v1 cannot be allowed to answer for v2.
 */
export function supersedeOpenGates(
  db: Database,
  runId: string,
  kind: string,
  options: { except?: string } = {},
): number {
  const open = listGates(db, { runId, status: 'open' }).filter(
    (gate) => gate.kind === kind && gate.id !== options.except,
  )
  let retired = 0
  for (const gate of open) {
    // Predicated on still being open rather than on the id alone. An answer
    // committing between the read above and this write would otherwise be
    // overwritten, changing a recorded decision into a superseded one.
    retired += settleIfOpen(db, gate.id, { status: 'superseded' })
  }
  return retired
}

/**
 * Retires a question nobody answered in time.
 *
 * Distinct from answering it. A permission ask holds a turn open and cannot
 * outlive it, so one that ran out was not decided by anybody, and recording it
 * as a rejection would put a decision in the history that no person made.
 */
export function expireGate(db: Database, id: string): boolean {
  // Conditional for the same reason superseding is: an answer landing between
  // a read and this write would be overwritten to `expired` while its decision
  // columns stayed populated, leaving a row that contradicts itself.
  return settleIfOpen(db, id, { status: 'expired' }) === 1
}

/**
 * Moves a gate to a terminal state, but only from `open`.
 *
 * One statement, so there is no window between deciding it is still open and
 * saying so. Returns how many rows that actually changed, which is the only
 * honest answer to "did I retire it".
 */
function settleIfOpen(
  db: Database,
  id: string,
  set: { status: GateStatus },
): number {
  query(db)
    .update(gates)
    .set({ ...set, answeredAt: new Date().toISOString() })
    .where(and(eq(gates.id, id), eq(gates.status, 'open')))
    .run()
  // drizzle's bun-sqlite driver returns void from run(), so the row count comes
  // from the connection that just executed the statement.
  const row = db.query<{ n: number }, []>('SELECT changes() AS n').get()
  return row?.n ?? 0
}

function refusalFor(gate: GateRow): AnswerRefusal {
  if (gate.status === 'superseded') {
    return { kind: 'superseded', gate }
  }
  if (gate.status === 'expired') {
    return { kind: 'expired', gate }
  }
  return { kind: 'already_answered', gate }
}
