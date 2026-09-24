import { createActor, type Snapshot, waitFor } from 'xstate'
import type { RunRef } from '@/modules/work/paths'
import type { RunDeps } from './deps'
import { provideRunDeps, releaseRunDeps } from './deps'
import { issueWorkMachine } from './issueWork'
import { persistSnapshot } from './snapshots'
import { type IssueWorkContext, workState } from './types'

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
  /**
   * A snapshot to carry on from, when this run is being picked back up.
   *
   * Restoring restarts the invocations, which is what the attempt record is
   * for: the station the process died in is entered again and answers from
   * what it already produced rather than doing it twice.
   */
  snapshot?: unknown
  /** Lowered by tests so the premise check does not wait a minute. */
  premiseIntervalMs?: number
}): Promise<{ state: string; context: IssueWorkContext }> {
  // Cancelled when the machine settles, so a turn still in flight for a run
  // that has already stopped does not spend another few minutes and commit
  // work nobody will use.
  const stopping = new AbortController()
  provideRunDeps(input.runId, { ...input.deps, signal: stopping.signal })

  // Input is required either way. When a snapshot is given it wins, and the
  // input is only what the machine would have used had there been none.
  const actor = createActor(issueWorkMachine, {
    input: {
      runId: input.runId,
      repo: input.repo,
      issueNumber: input.issueNumber,
      maxRevisions: input.deps.config.maxRevisions,
      premiseBody: input.deps.issue.body ?? '',
      ...(input.premiseIntervalMs === undefined
        ? {}
        : { premiseIntervalMs: input.premiseIntervalMs }),
    },
    ...(input.snapshot === undefined
      ? {}
      : { snapshot: input.snapshot as Snapshot<unknown> }),
  })

  // Chained rather than collected. Each transition overwrites the same row and
  // the same document, so letting them race means a later state can be
  // overwritten by an earlier one finishing second, and the snapshot then
  // describes a run that has already moved on.
  let writes: Promise<void> = Promise.resolve()
  actor.subscribe((snapshot) => {
    const value = workState(snapshot.value)
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
    return { state: workState(settled.value), context: settled.context }
  } finally {
    stopping.abort()
    actor.stop()
    releaseRunDeps(input.runId)
  }
}
