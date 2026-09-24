import type { Database } from 'bun:sqlite'
import type { AcpPermissionDecision, AcpPermissionRequest } from 'acpx/runtime'
import { emit } from '@/events/bus'
import { logger } from '@/lib/log'
import { expireGate, openGate, readGate } from '@/modules/gates'

const log = logger('permission')

/** How often the wait asks whether somebody answered. */
const POLL_MS = 500

export interface PermissionGateInput {
  readonly db: Database
  readonly runId: string
  readonly repo: string
  readonly issue: number
  readonly station: string
  /** How long a turn may sit on a question before it falls through. */
  readonly waitMs: number
}

/**
 * Asks a person whether the agent may do this, if anyone is there to ask.
 *
 * Fundamentally different from the plan gate despite the shared table, and the
 * difference is not stylistic. This holds a JSON-RPC call open inside a live
 * turn, so it dies with the process and is bounded by the turn timeout. It is
 * a question with a deadline, not a durable gate.
 *
 * Returning `undefined` hands the decision back to the station's permission
 * mode, which is exactly today's behaviour. That is the correct outcome for
 * every failure here: nobody answered, the run stopped, the read failed. A
 * feature that cannot reach a person must not be able to stall a factory.
 */
export function permissionGate(input: PermissionGateInput) {
  return async (
    request: AcpPermissionRequest,
    context: { signal: AbortSignal },
  ): Promise<AcpPermissionDecision | undefined> => {
    const gateId = openGate(input.db, {
      runId: input.runId,
      kind: 'permission',
      artifactVersion: String(Date.now()),
    })
    const asked = describe(request)
    log.info('asking before the agent proceeds', {
      gateId,
      station: input.station,
      tool: asked,
    })
    emit({
      type: 'gate.opened',
      runId: input.runId,
      gateId,
      kind: 'permission',
      repo: input.repo,
      issue: input.issue,
      at: Date.now(),
    })

    const decision = await waitForDecision(input, gateId, context.signal)
    if (decision === undefined) {
      // Marked rather than left open: this one cannot be answered later, and a
      // question still listed as waiting is a question a person will try.
      expire(input.db, gateId)
      log.info('nobody answered in time, falling back to the permission mode', {
        gateId,
      })
      return undefined
    }
    emit({
      type: 'gate.answered',
      runId: input.runId,
      gateId,
      decision: decision === 'allow_once' ? 'approved' : 'rejected',
      answeredOn: readGate(input.db, gateId)?.answeredOn ?? 'unknown',
      at: Date.now(),
    })
    return { outcome: decision }
  }
}

type Outcome = 'allow_once' | 'reject_once'

async function waitForDecision(
  input: PermissionGateInput,
  gateId: string,
  signal: AbortSignal,
): Promise<Outcome | undefined> {
  const deadline = Date.now() + input.waitMs
  while (Date.now() < deadline) {
    if (signal.aborted) {
      return undefined
    }
    try {
      const gate = readGate(input.db, gateId)
      if (gate?.status === 'answered' && gate.decision !== null) {
        return gate.decision === 'approved' ? 'allow_once' : 'reject_once'
      }
    } catch {
      // A transient read failure is not a decision. Ask again next tick.
    }
    await Bun.sleep(POLL_MS)
  }
  return undefined
}

function expire(db: Database, gateId: string): void {
  try {
    expireGate(db, gateId)
  } catch {
    // Tidying, not correctness. The turn has already fallen through.
  }
}

/** What the agent is asking to do, for a person reading the question. */
function describe(request: AcpPermissionRequest): string {
  return (
    request.inferredKind ??
    (request.raw as { toolCall?: { title?: string } }).toolCall?.title ??
    'an action'
  )
}
