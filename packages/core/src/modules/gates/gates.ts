import type { Database } from 'bun:sqlite'
import { and, desc, eq } from 'drizzle-orm'
import { query } from '@/modules/db/query'
import { type GateRow, gates } from '@/modules/db/schema/schema'
import { publishGateAnswered } from './bus'
import type {
  AnswerGateInput,
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
    })
    .onConflictDoNothing()
    .run()
  return id
}

export function gateId(input: {
  runId: string
  kind: string
  artifactVersion?: string
}): string {
  // The version is part of the identity because a gate on v2 is a different
  // question from the one asked about v1, and answering the old one must not
  // answer the new one.
  return `${input.runId}:${input.kind}:${input.artifactVersion ?? '0'}`
}

export function readGate(db: Database, id: string): GateRow | undefined {
  return query(db).select().from(gates).where(eq(gates.id, id)).get()
}

export function listGates(db: Database, filter: GateQuery = {}): GateRow[] {
  const where = [
    ...(filter.status === undefined ? [] : [eq(gates.status, filter.status)]),
    ...(filter.runId === undefined ? [] : [eq(gates.runId, filter.runId)]),
  ]
  return query(db)
    .select()
    .from(gates)
    .where(where.length === 0 ? undefined : and(...where))
    .orderBy(desc(gates.openedAt))
    .limit(filter.limit ?? 100)
    .all()
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
    if (gate.status === 'superseded') {
      return { ok: false, refusal: { kind: 'superseded', gate } } as const
    }
    if (gate.status === 'answered') {
      return { ok: false, refusal: { kind: 'already_answered', gate } } as const
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
): number {
  const open = listGates(db, { runId, status: 'open' }).filter(
    (gate) => gate.kind === kind,
  )
  for (const gate of open) {
    query(db)
      .update(gates)
      .set({ status: 'superseded' })
      .where(eq(gates.id, gate.id))
      .run()
  }
  return open.length
}
