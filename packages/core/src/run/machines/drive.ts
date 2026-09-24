import { createActor, waitFor } from 'xstate'
import type { RunRef } from '@/modules/work/paths'
import type { RunDeps } from './deps'
import { provideRunDeps, releaseRunDeps } from './deps'
import { type IssueWorkContext, issueWorkMachine } from './issueWork'
import { persistSnapshot } from './snapshots'

/**
 * Runs one issue's machine to a final state, persisting as it goes.
 *
 * The dependencies are registered before the actor starts and released after
 * it settles, so an actor restored later cannot reach a worktree that is gone.
 */
export async function driveIssueWork(input: {
  runId: string
  repo: string
  issueNumber: number
  run: RunRef
  deps: RunDeps
}): Promise<{ state: string; context: IssueWorkContext }> {
  provideRunDeps(input.runId, input.deps)

  const actor = createActor(issueWorkMachine, {
    input: {
      runId: input.runId,
      repo: input.repo,
      issueNumber: input.issueNumber,
      maxRevisions: input.deps.config.maxRevisions,
    },
  })

  // Chained rather than collected. Each transition overwrites the same row and
  // the same document, so letting them race means a later state can be
  // overwritten by an earlier one finishing second, and the snapshot then
  // describes a run that has already moved on.
  let writes: Promise<void> = Promise.resolve()
  actor.subscribe((snapshot) => {
    const value = String(snapshot.value)
    const persisted = actor.getPersistedSnapshot()
    writes = writes.then(() =>
      persistSnapshot({
        db: input.deps.db,
        run: input.run,
        runId: input.runId,
        machine: 'issueWork',
        value,
        snapshot: persisted,
      }),
    )
  })

  try {
    actor.start()
    const settled = await waitFor(actor, (s) => s.status === 'done', {
      timeout: Number.POSITIVE_INFINITY,
    })
    await writes

    // `approved` carries the plan, the verdict and the report delivery needs;
    // `finished` carries why it stopped. The caller tells them apart by state
    // rather than by guessing from which fields are populated.
    return { state: String(settled.value), context: settled.context }
  } finally {
    actor.stop()
    releaseRunDeps(input.runId)
  }
}
