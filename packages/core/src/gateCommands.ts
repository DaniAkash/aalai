import { loadConfig } from '@/config'
import { localUser } from '@/lib/env'
import { logger } from '@/lib/log'
import { bad, block, heading, note, ok, table } from '@/lib/output'
import type { GateDecision, GateRow } from '@/modules/db/schema/schema'
import {
  type AnswerResult,
  type AnswerSource,
  answerGate,
  listGates,
  readGate,
} from '@/modules/gates'
import { readArtifact } from '@/modules/work/artifacts'
import { subjectOf, waitedFor } from '@/shared/format'
import { openState } from '@/watch/state'

const log = logger('gates')

/**
 * What this gate is asking, in one cell.
 *
 * A plan gate points at an artifact a person reads; a permission ask has none,
 * so without the stored summary the row would say only how long it has waited.
 */
function asking(gate: GateRow): string {
  if (gate.summary !== null && gate.summary !== '') {
    return gate.summary
  }
  return gate.kind === 'plan'
    ? `approve the plan (v${gate.artifactVersion ?? '?'})`
    : gate.kind
}

export function showGates(args: readonly string[]): void {
  const repo = flagValue(args, '--repo')
  const db = openState()
  const gates = listGates(db, { status: 'open' }).filter(
    (gate) =>
      repo === undefined || subjectOf(gate.runId).startsWith(`${repo}#`),
  )
  if (gates.length === 0) {
    note('nothing is waiting on you')
    db.close()
    return
  }
  heading('waiting on you')
  table(
    ['gate', 'subject', 'asking', 'waiting'],
    gates.map((gate) => [
      gate.id,
      subjectOf(gate.runId),
      asking(gate),
      waitedFor(gate.openedAt),
    ]),
  )
  db.close()
}

export async function showGate(args: readonly string[]): Promise<void> {
  const [gateId] = args
  if (gateId === undefined) {
    bad('usage: aalai show <gate-id>')
    process.exitCode = 1
    return
  }
  const db = openState()
  const gate = readGate(db, gateId)
  db.close()
  if (gate === undefined) {
    bad('no such gate', gateId)
    process.exitCode = 1
    return
  }
  heading(`${gate.kind} gate`)
  note('subject', subjectOf(gate.runId))
  note('status', gate.status)
  note('asking', asking(gate))
  note('version', gate.artifactVersion ?? 'none')
  if (gate.decision !== null) {
    note('decision', `${gate.decision} by ${gate.answeredBy ?? 'someone'}`)
  }
  if (gate.artifactPath === null) {
    return
  }
  const body = await readArtifact(gate.artifactPath)
  if (body === undefined) {
    bad('the artifact is missing', gate.artifactPath)
    return
  }
  heading(gate.artifactPath)
  block(body)
}

/**
 * Records a decision, preferring the running factory when there is one.
 *
 * Posting to the API wakes a parked run through the in-process bus, which is
 * immediate. Writing the row directly works with nothing running at all and is
 * noticed by the run's own poll within a couple of seconds. The outcome is the
 * same either way, so a factory that is not running is not an error.
 */
export async function answerGateCommand(
  decision: GateDecision,
  args: readonly string[],
): Promise<void> {
  const [gateId] = args
  if (gateId === undefined) {
    bad(`usage: aalai ${verb(decision)} <gate-id> [--reason "..."]`)
    process.exitCode = 1
    return
  }
  const reason = flagValue(args, '--reason')
  const answeredBy = localUser()

  const viaApi = await answerThroughApi(gateId, decision, reason, answeredBy)
  const result =
    viaApi ??
    answerLocally(gateId, decision, reason, answeredBy, viaApi === null)
  report(result, decision)
}

function answerLocally(
  gateId: string,
  decision: GateDecision,
  reason: string | undefined,
  answeredBy: string,
  direct: boolean,
): AnswerResult {
  if (direct) {
    log.debug('no factory reachable, writing the decision directly')
  }
  const db = openState()
  const result = answerGate(db, {
    gateId,
    decision,
    ...(reason === undefined ? {} : { reason }),
    answeredBy,
    answeredOn: 'cli' satisfies AnswerSource,
  })
  db.close()
  return result
}

/** The API when one is listening, or null when there is none to talk to. */
async function answerThroughApi(
  gateId: string,
  decision: GateDecision,
  reason: string | undefined,
  answeredBy: string,
): Promise<AnswerResult | null> {
  const config = await loadConfig()
  try {
    const response = await fetch(
      `http://127.0.0.1:${config.uiPort}/api/gates/${encodeURIComponent(gateId)}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision,
          answeredBy,
          answeredOn: 'cli',
          ...(reason === undefined ? {} : { reason }),
        }),
        signal: AbortSignal.timeout(1500),
      },
    )
    // A reachable server that refuses the answer has still answered the
    // question. Only an unreachable one falls through to the direct write.
    if (response.status === 401) {
      return null
    }
    return (await response.json()) as AnswerResult
  } catch {
    return null
  }
}

function report(result: AnswerResult, decision: GateDecision): void {
  if (result.ok) {
    ok(`${decision}`, result.gate.id)
    return
  }
  if (result.refusal.kind === 'not_found') {
    bad('no such gate')
  } else if (result.refusal.kind === 'already_answered') {
    bad(
      'already answered',
      `${result.refusal.gate.decision} by ${result.refusal.gate.answeredBy ?? 'someone'} on ${result.refusal.gate.answeredOn ?? 'another surface'}`,
    )
  } else if (result.refusal.kind === 'superseded') {
    bad(
      'the plan changed under this gate',
      'run `aalai gates` for the version that now stands',
    )
  } else {
    bad(
      'this question expired',
      'a permission ask only stands while its turn is open',
    )
  }
  process.exitCode = 1
}

function verb(decision: GateDecision): string {
  return decision === 'approved'
    ? 'approve'
    : decision === 'rejected'
      ? 'reject'
      : 'changes'
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}
