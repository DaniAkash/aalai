import { fromCallback } from 'xstate'
import { emit } from '@/events/bus'
import { logger } from '@/lib/log'
import {
  openGate,
  readGate,
  subscribeGateAnswered,
  supersedeOpenGates,
} from '@/modules/gates'
import { latestArtifact } from '@/modules/work/artifacts'
import { runDeps } from './deps'

const log = logger('gate')

/** How often a parked run asks the database whether it was answered. */
const GATE_POLL_MS = 2_000

/**
 * Opens a gate, then waits for a person from whichever process they are in.
 *
 * Opening happens here rather than in an entry action because the artifact
 * version has to be read from disk, and an entry action cannot await. The gate
 * must name the exact bytes it is asking about: an approval that does not pin
 * to a version silently transfers to whatever the analyst writes next.
 *
 * Three inputs settle it, in this order, because they answer three different
 * situations and only the last is guaranteed:
 *
 * 1. Read the row once opened. A run resumed from a cold snapshot may already
 *    have been answered while nothing was running, and must not wait again.
 * 2. Subscribe in process, which makes an answer from this process instant.
 * 3. Poll the row. `aalai approve` runs in a different process from the
 *    factory holding this machine and nothing in memory crosses that, so the
 *    database is the only channel the two actually share. This is the
 *    mechanism; the subscription is only a latency optimisation.
 *
 * Polling is cheap here in a way it would not be elsewhere: a run parked at a
 * gate is doing nothing else, and the read is one indexed row.
 */
export const gateKeeper = fromCallback<
  { type: string },
  { runId: string; repo: string; issue: number; kind: string; pollMs?: number }
>(({ input, sendBack }) => {
  let stopped = false
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  const settle = (gateId: string, source: string): boolean => {
    const deps = runDeps(input.runId)
    const gate = readGate(deps.db, gateId)
    if (gate === undefined) {
      return false
    }
    if (gate.status === 'superseded') {
      sendBack({ type: 'GATE_SUPERSEDED', gateId: gate.id })
      return true
    }
    if (gate.status !== 'answered' || gate.decision === null) {
      return false
    }
    log.info('gate answered', {
      gateId: gate.id,
      decision: gate.decision,
      on: gate.answeredOn ?? 'unknown',
      noticedBy: source,
    })
    emit({
      type: 'gate.answered',
      runId: input.runId,
      gateId: gate.id,
      decision: gate.decision,
      answeredOn: gate.answeredOn ?? 'unknown',
      at: Date.now(),
    })
    sendBack({
      type: 'GATE_ANSWERED',
      gateId: gate.id,
      decision: gate.decision,
      reason: gate.reason ?? '',
    })
    return true
  }

  const start = async (): Promise<void> => {
    const deps = runDeps(input.runId)
    const artifact = await latestArtifact(deps.run.subject, input.kind)
    if (stopped) {
      return
    }
    const gateId = openGate(deps.db, {
      runId: input.runId,
      kind: 'plan',
      ...(artifact === undefined
        ? {}
        : {
            artifactPath: artifact.id,
            artifactVersion: String(artifact.version),
          }),
    })
    // Anything this run left open on an earlier version is retired here, and
    // only here, because this is the one place that knows which version now
    // stands. A run can leave this state without answering (the issue being
    // rewritten underneath it does exactly that), and without this the old
    // question stays in the inbox forever as something nobody can usefully
    // answer.
    const retired = supersedeOpenGates(deps.db, input.runId, 'plan', {
      except: gateId,
    })
    if (retired > 0) {
      log.info('retired gates asked about an older version', { retired })
    }
    sendBack({ type: 'GATE_OPENED', gateId })
    log.info('waiting for a person', {
      gateId,
      kind: input.kind,
      version: artifact?.version ?? 0,
    })
    emit({
      type: 'gate.opened',
      runId: input.runId,
      gateId,
      kind: input.kind,
      repo: input.repo,
      issue: input.issue,
      at: Date.now(),
    })

    if (settle(gateId, 'resume') || stopped) {
      return
    }
    unsubscribe = subscribeGateAnswered((gate) => {
      if (gate.id === gateId) {
        settle(gate.id, 'bus')
      }
    })
    timer = setInterval(() => {
      try {
        settle(gateId, 'poll')
      } catch {
        // The run outlives a transient read failure; the next tick asks again.
      }
    }, input.pollMs ?? GATE_POLL_MS)
  }

  void start()

  return () => {
    stopped = true
    unsubscribe?.()
    if (timer !== undefined) {
      clearInterval(timer)
    }
  }
})
