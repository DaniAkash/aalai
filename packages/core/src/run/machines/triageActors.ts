import { fromPromise } from 'xstate'
import { getIssue } from '@/lib/gh'
import {
  type DeliveryReport,
  deliverOutbox,
  releasingGate,
} from '@/modules/outbound/deliver'
import { latestArtifact } from '@/modules/work/artifacts'
import { appendEntry, readConversation } from '@/modules/work/conversation'
import {
  bindIntentsToGate,
  queueOutbound,
  readJson,
} from '@/modules/work/store'
import { recordTriage } from '@/run/artifacts'
import { runClassifier } from '@/run/stations'
import type { Triage } from '@/run/stations/schemas'
import { runDeps } from './deps'
import { runAttempt } from './runner'

/**
 * Decides what an issue is.
 *
 * Attempt backed and keyed on the generation rather than on a fixed number: a
 * reclassification is a new judgement and must buy its own turn, where a
 * restart of the same judgement must not. That is the same distinction the
 * analyst draws between a revision and a replan.
 */
export const classifier = fromPromise(
  async ({
    input,
    signal,
  }: {
    input: { runId: string; issueNumber: number; generation: number }
    signal: AbortSignal
  }): Promise<Triage> => {
    const deps = runDeps(input.runId)
    const outcome = await runAttempt<Triage, { reports: number }>({
      db: deps.db,
      run: deps.run,
      runId: input.runId,
      station: 'classifier',
      revision: input.generation,
      // Recorded before the turn starts, because reconciling asks whether this
      // judgement landed and that only means something against a starting
      // point. Reading the report file alone cannot tell a reclassification
      // that crashed apart from one that never ran: both leave the previous
      // generation's report sitting there.
      captureBefore: async () => ({
        reports:
          (await latestArtifact(deps.run.subject, 'triage'))?.version ?? 0,
      }),
      reconcile: async (before) => {
        if (before === undefined) {
          return undefined
        }
        const latest = await latestArtifact(deps.run.subject, 'triage')
        if ((latest?.version ?? 0) <= before.reports) {
          return undefined
        }
        return await readJson<Triage>(deps.run, 'triage')
      },
      execute: async () => {
        const issue = await getIssue(deps.repo, input.issueNumber)
        const { triage, result } = await runClassifier({
          runId: input.runId,
          repo: deps.repo,
          issue,
          worktree: deps.workspace.worktreePath,
          // What has already been said about this issue, which on a second
          // pass is where a person's correction lives.
          history: await readConversation(deps.run.subject),
          config: deps.config,
          signal,
        })
        // Only when the station did not record it itself, the same as the
        // analyst: a tool call already wrote the report, and writing it again
        // would make a second version of one judgement.
        if (result.recorded.triage === undefined) {
          await recordTriage(
            deps.run.subject,
            deps.run,
            { number: issue.number, title: issue.title },
            triage,
          )
        }
        return triage
      },
    })
    return outcome.value
  },
)

export const deliverer = fromPromise(
  async ({ input }: { input: { runId: string } }): Promise<DeliveryReport> => {
    const deps = runDeps(input.runId)
    return await deliverOutbox({
      db: deps.db,
      run: deps.run,
      repo: deps.repo,
      issueNumber: deps.issue.number,
    })
  },
)

/**
 * Says which question the queued intents belong to.
 *
 * A station queues an intent before the gate exists, because the gate is opened
 * on the artifact the station just wrote. Binding is what lets delivery refuse
 * anything a person has not released.
 */
export const binder = fromPromise(
  async ({
    input,
  }: {
    input: { runId: string; gateId: string }
  }): Promise<number> => {
    const deps = runDeps(input.runId)
    return await bindIntentsToGate(deps.run, input.gateId)
  },
)

/**
 * Writes a person's correction where the next classification will read it.
 *
 * The discussion is already where a person and a station talk, so a correction
 * goes there rather than into a column of its own. That also means the
 * classifier sees it in the same form as everything else said about this issue,
 * and a correction that needed more than one sentence is not truncated into an
 * enum.
 */
export const corrector = fromPromise(
  async ({
    input,
  }: {
    input: { runId: string; correction: string }
  }): Promise<void> => {
    const deps = runDeps(input.runId)
    const said =
      input.correction.trim() === ''
        ? 'That classification is wrong. Look again.'
        : input.correction.trim()
    await appendEntry(deps.run.subject, {
      author: 'maintainer',
      role: 'maintainer',
      body: said,
    })
  },
)

/**
 * Queues the close for an issue nobody came back to.
 *
 * Queued rather than closed, like everything else that reaches the outside:
 * the maintainer released this run's outbound when they approved the question,
 * and the close travels the same path so it can still be seen before it lands.
 */
export const staleCloser = fromPromise(
  async ({ input }: { input: { runId: string } }): Promise<void> => {
    const deps = runDeps(input.runId)
    const released = releasingGate(deps.db, input.runId)
    const at = new Date().toISOString()
    await queueOutbound(deps.run, {
      kind: 'comment_on_issue',
      body: 'Closing this for now, since the detail it needs never arrived. Comment here with it and it will be looked at again.',
      station: 'classifier',
      queuedAt: at,
      ...(released === undefined ? {} : { gateId: released }),
    })
    await queueOutbound(deps.run, {
      kind: 'close_issue',
      body: '',
      station: 'classifier',
      queuedAt: at,
      closeReason: 'not_planned',
      ...(released === undefined ? {} : { gateId: released }),
    })
  },
)
