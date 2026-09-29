import { fromPromise } from 'xstate'
import { latestArtifact } from '@/modules/work/artifacts'
import type { ConversationEntry } from '@/modules/work/conversation'
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
    const history = await readConversation(deps.run.subject)
    const outcome = await runAttempt<{ analysis?: Analysis }, ReplyBaseline>({
      db: deps.db,
      run: deps.run,
      runId: input.runId,
      station: 'analyst',
      revision: 0,
      attemptId: `${input.runId}:analyst-reply:${input.entryId}`,
      // Persisted, not recomputed. Reading the latest plan again on a restart
      // reads the version the dead turn wrote, so the comparison found no change
      // and bought another turn, which wrote a third version. This is what
      // `captureBefore` is for and not using it was the defect.
      captureBefore: async () => ({
        planVersion:
          (await latestArtifact(deps.run.subject, 'plan'))?.version ?? 0,
        answers: countAnswersAfter(history, input.entryId),
      }),
      reconcile: async (before) => {
        if (before === undefined) {
          return undefined
        }
        // Either side effect means the turn landed. A crash between them leaves
        // the other to be redone, which is the honest outcome: the work that is
        // on disk is kept and only what is missing is bought again.
        const latest = await latestArtifact(deps.run.subject, 'plan')
        if ((latest?.version ?? 0) > before.planVersion) {
          const analysis = await readJson<Analysis>(deps.run, 'analysis')
          return analysis === undefined ? {} : { analysis }
        }
        const now = await readConversation(deps.run.subject)
        return countAnswersAfter(now, input.entryId) > before.answers
          ? {}
          : undefined
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

/** What the run looked like before a reply turn started. */
interface ReplyBaseline {
  readonly planVersion: number
  readonly answers: number
}

/**
 * Station entries after the question being answered.
 *
 * The count, not a boolean, because an answer to a later question would
 * otherwise read as an answer to this one on a restart.
 */
function countAnswersAfter(
  entries: readonly ConversationEntry[],
  entryId: string,
): number {
  const at = entries.findIndex((entry) => entry.id === entryId)
  if (at === -1) {
    return 0
  }
  return entries.slice(at + 1).filter((entry) => entry.role === 'station')
    .length
}
