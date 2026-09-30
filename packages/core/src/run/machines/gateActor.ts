import { fromCallback } from 'xstate'
import { emit } from '@/events/bus'
import { logger } from '@/lib/log'
import type { GateKind } from '@/modules/db/schema/schema'
import {
  openGate,
  readGate,
  subscribeGateAnswered,
  supersedeOpenGates,
} from '@/modules/gates'
import { latestArtifact } from '@/modules/work/artifacts'
import type { ConversationEntry } from '@/modules/work/conversation'
import { readConversation } from '@/modules/work/conversation'
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
  {
    runId: string
    repo: string
    issue: number
    kind: GateKind
    /**
     * One line saying what this gate is about, when the kind alone is not enough.
     *
     * A plan gate needs none: the artifact is the question. A trust gate does,
     * because the thing a person needs to know is why they are being asked, and
     * that is a fact the run established rather than anything readable from the
     * gate's kind.
     */
    summary?: string
    pollMs?: number
  }
>(({ input, sendBack }) => {
  let stopped = false
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  // The last thing said, when a person said it, is a reply nobody has answered.
  // Derived from the conversation rather than tracked in a row: the answer is an
  // entry in the same file, so a turn that landed leaves nothing pending and a
  // restart reconciles itself.
  //
  // Announced on every tick while one is pending, rather than once. The machine
  // decides what to do with it, because only the machine knows whether it is
  // already mid answer: a reply that arrived during a turn would otherwise be
  // dropped by a state with no handler for it and never mentioned again.
  let announced: string | undefined
  const noticeReply = async (gateId: string): Promise<void> => {
    if (stopped) {
      return
    }
    const deps = runDeps(input.runId)
    const gate = readGate(deps.db, gateId)
    if (gate === undefined || gate.status !== 'open') {
      return
    }
    const entries = await readConversation(deps.run.subject)
    // Checked again on the far side of the await. Stopping clears the timer but
    // cannot unwind a read already in flight, and the run this belongs to may be
    // gone by the time one comes back.
    if (stopped) {
      return
    }
    // Only what was said after this gate opened. The conversation belongs to the
    // subject and outlives any one gate, so a question left unanswered when an
    // earlier gate was approved is still sitting there; without this the next
    // run on the same subject would adopt it and spend a turn on something
    // somebody already moved past.
    const since = entries.filter((entry) => saidAfter(entry.at, gate.openedAt))
    const last = unansweredQuestion(since)
    if (last === undefined) {
      announced = undefined
      return
    }
    if (last.id !== announced) {
      announced = last.id
      log.info('a maintainer replied at the gate', {
        runId: input.runId,
        entry: last.id,
      })
    }
    sendBack({ type: 'REPLY_RECEIVED', entryId: last.id, question: last.body })
  }

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
    // Announced only when the answer came from somewhere else. `bus` means
    // answerGate ran in this process and already announced it, and a second
    // one is not a harmless duplicate: the event log is replayed into the
    // interface, so it shows as the gate being answered twice.
    if (source !== 'bus') {
      emit({
        type: 'gate.answered',
        runId: input.runId,
        gateId: gate.id,
        decision: gate.decision,
        answeredOn: gate.answeredOn ?? 'unknown',
        at: Date.now(),
      })
    }
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
      kind: input.kind,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
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
    const retired = supersedeOpenGates(deps.db, input.runId, input.kind, {
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
    await noticeReply(gateId)
    timer = setInterval(() => {
      try {
        if (settle(gateId, 'poll')) {
          return
        }
        void noticeReply(gateId).catch(() => {
          // Same reasoning as below: the next tick asks again.
        })
      } catch {
        // The run outlives a transient read failure; the next tick asks again.
      }
    }, input.pollMs ?? GATE_POLL_MS)
  }

  // Not left to float. A rejection here means the gate never opened and the run
  // waits on a question nobody was asked, and as a bare `void` it disappears as
  // an unhandled rejection with nothing naming what failed.
  void start().catch((error: unknown) => {
    log.error('the gate could not be opened', {
      runId: input.runId,
      error: error instanceof Error ? error.message : String(error),
    })
  })

  return () => {
    stopped = true
    unsubscribe?.()
    if (timer !== undefined) {
      clearInterval(timer)
    }
  }
})

/**
 * Whether an entry was written after a gate opened.
 *
 * The gate's timestamp comes from SQLite as `YYYY-MM-DD HH:MM:SS` in UTC and an
 * entry's is an ISO string, so the two need putting on the same footing before
 * they can be compared at all.
 */
function saidAfter(entryAt: string, gateOpenedAt: string): boolean {
  const said = Date.parse(entryAt)
  const opened = Date.parse(
    gateOpenedAt.includes('T')
      ? gateOpenedAt
      : `${gateOpenedAt.replace(' ', 'T')}Z`,
  )
  if (Number.isNaN(said) || Number.isNaN(opened)) {
    // Unreadable timestamps must not silently swallow a real reply.
    return true
  }
  // No grace. A gate opened now carries milliseconds, so the comparison is
  // exact; a row written before that carries whole seconds and reads as having
  // opened at the start of its second, which can still admit a question from
  // earlier in that same second. That is the old rows' residue and not worth a
  // migration: it costs one question being carried into a gate it preceded by
  // under a second, and being asked again is the harmless direction.
  return said >= opened
}

/**
 * The oldest question still owed an answer, or nothing.
 *
 * A queue rather than a count. Counting told us whether anything was owed but
 * not which, so the newest was announced: with two questions waiting, the
 * second was answered, the first stayed owed forever, and the keeper then
 * re-announced a question the machine had already answered while its guard
 * refused it every time. That is a stall, not a lost reply, and a restart with
 * two unanswered questions reaches it immediately.
 *
 * Oldest first, because that is the order they were asked in and the order the
 * person expects them back.
 *
 * "The last entry is a person's" was the rule before counting, and was wrong a
 * third way: a question asked while the analyst was mid answer stopped being
 * last the moment that answer was appended after it.
 */
function unansweredQuestion(
  entries: readonly ConversationEntry[],
): ConversationEntry | undefined {
  const owed: ConversationEntry[] = []
  for (const entry of entries) {
    if (entry.role === 'maintainer') {
      owed.push(entry)
    } else {
      // A station entry answers the oldest question outstanding, so the note
      // that opened the discussion cannot cancel a question asked after it.
      owed.shift()
    }
  }
  return owed[0]
}
