import type { Database } from 'bun:sqlite'
import type { StationId } from '@/events/events.types'
import { logger } from '@/lib/log'
import type { RunRef } from '@/modules/work/paths'
import {
  attemptIdFor,
  beginAttempt,
  readAttempt,
  readAttemptBefore,
  readAttemptOutcome,
  settleAttempt,
  writeAttemptBefore,
  writeAttemptOutcome,
} from './attempts'

const log = logger('attempt')

export interface AttemptInput<T, B = unknown> {
  readonly db: Database
  readonly run: RunRef
  readonly runId: string
  readonly station: StationId
  /** Which pass through this station: 0 on the first, then the revision index. */
  readonly revision: number
  /** The expensive thing. Only called when nothing already did it. */
  readonly execute: () => Promise<T>
  /**
   * What was true before the work started, recorded the first time it does.
   *
   * Reconciling asks whether the work landed, which only means something
   * against a starting point: a second revision would otherwise see the first
   * revision's commit and call itself finished without doing anything.
   */
  readonly captureBefore?: () => Promise<B>
  /**
   * What reality says, for an attempt that started and never settled.
   *
   * The snapshot is a hint and the worktree, the branch and the artifacts on
   * disk are the truth. Returning a value here means the work landed and the
   * turn must not run again.
   */
  readonly reconcile?: (before: B | undefined) => Promise<T | undefined>
}

export interface AttemptOutcome<T> {
  readonly value: T
  /** How the value was obtained, which the evals assert on. */
  readonly source: 'recorded' | 'reconciled' | 'executed'
}

/**
 * Runs a station once, however many times it is invoked.
 *
 * Restoring a machine restarts its invocations, so this is what stands between
 * a resumed run and a second four minute agent turn on top of work that is
 * already committed. Recorded first, reality second, and only then the work.
 */
export async function runAttempt<T, B = unknown>(
  input: AttemptInput<T, B>,
): Promise<AttemptOutcome<T>> {
  const id = attemptIdFor(input.runId, input.station, input.revision)
  const existing = readAttempt(input.db, id)

  if (existing?.status === 'succeeded') {
    const recorded = await readAttemptOutcome<T>(input.run, id)
    if (recorded !== undefined) {
      log.info('attempt already succeeded, not running it again', {
        station: input.station,
        attempt: id,
      })
      return { value: recorded, source: 'recorded' }
    }
    // The row says it landed and the document is gone. Reality decides, and if
    // reality cannot answer either, the work is done again rather than assumed.
    log.warn('attempt recorded as succeeded but its outcome is missing', {
      attempt: id,
    })
  }

  if (existing?.status === 'started' && input.reconcile !== undefined) {
    const before = await readAttemptBefore<B>(input.run, id)
    const reconciled = await input.reconcile(before)
    if (reconciled !== undefined) {
      const path = await writeAttemptOutcome(input.run, id, reconciled)
      settleAttempt(input.db, id, 'succeeded', path)
      log.info('attempt reconciled against what is on disk', {
        station: input.station,
        attempt: id,
      })
      return { value: reconciled, source: 'reconciled' }
    }
  }

  // Captured before the row says started, so a crash between the two leaves
  // an attempt that reconciling will simply not recognise, rather than one it
  // recognises against the wrong starting point.
  if (existing === undefined && input.captureBefore !== undefined) {
    await writeAttemptBefore(input.run, id, await input.captureBefore())
  }
  beginAttempt(input.db, {
    id,
    runId: input.runId,
    station: input.station,
  })
  try {
    const value = await input.execute()
    const path = await writeAttemptOutcome(input.run, id, value)
    settleAttempt(input.db, id, 'succeeded', path)
    return { value, source: 'executed' }
  } catch (error) {
    settleAttempt(input.db, id, 'failed')
    throw error
  }
}
