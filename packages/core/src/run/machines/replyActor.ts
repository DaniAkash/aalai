import { fromPromise } from 'xstate'
import { latestArtifact } from '@/modules/work/artifacts'
import { readConversation } from '@/modules/work/conversation'
import { readJson } from '@/modules/work/store'
import { runAnalystReply } from '@/run/stations'
import type { Analysis } from '@/run/stations/schemas'
import { runDeps } from './deps'
import { runAttempt } from './runner'
/**
 * One turn answering a maintainer's reply, with the gate still open.
 *
 * Attempt backed for the same reason every station turn is: restoring a
 * snapshot restarts invocations, and this one buys an agent turn. Keyed by the
 * entry it answers rather than by a revision index, because replies are not a
 * numbered sequence of passes and the same message must always map to the same
 * attempt.
 *
 * Reconciling matters more here than it looks. A turn can call `write_plan` and
 * die before it answers, and the conversation alone cannot tell that apart from
 * a turn that never ran: both leave the maintainer's message as the last entry.
 * The attempt does, and the plan version that appeared is the evidence.
 */
export const replier = fromPromise(
  async ({
    input,
    signal,
  }: {
    input: { runId: string; entryId: string; question: string }
    signal: AbortSignal
  }): Promise<{ analysis?: Analysis }> => {
    const deps = runDeps(input.runId)
    const before = await latestArtifact(deps.run.subject, 'plan')
    const history = await readConversation(deps.run.subject)
    const outcome = await runAttempt<{ analysis?: Analysis }>({
      db: deps.db,
      run: deps.run,
      runId: input.runId,
      station: 'analyst',
      revision: 0,
      attemptId: `${input.runId}:analyst-reply:${input.entryId}`,
      reconcile: async () => {
        // A plan newer than the one this reply started against means the turn
        // got as far as revising. Adopt it rather than paying for the turn
        // again, which would produce a second version of the same revision.
        const latest = await latestArtifact(deps.run.subject, 'plan')
        if (latest === undefined || latest.version === (before?.version ?? 0)) {
          return undefined
        }
        const analysis = await readJson<Analysis>(deps.run, 'analysis')
        return analysis === undefined ? undefined : { analysis }
      },
      execute: async () => {
        const { analysis } = await runAnalystReply({
          runId: input.runId,
          repo: deps.repo,
          issueNumber: deps.issue.number,
          worktree: deps.workspace.worktreePath,
          question: input.question,
          // The reply itself is passed separately, so it is not repeated here.
          history: history.filter((entry) => entry.id !== input.entryId),
          config: deps.config,
          signal,
        })
        return analysis === undefined ? {} : { analysis }
      },
    })
    return outcome.value
  },
)
