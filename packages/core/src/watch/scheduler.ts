import type { Database } from 'bun:sqlite'
import type { Config } from '@/config'
import { logger } from '@/lib/log'
import {
  claimNextQueued,
  type QueueEntry,
  runningCount,
} from '@/modules/runs/queue'

const log = logger('scheduler')

export interface Promotion {
  readonly started: QueueEntry[]
  readonly running: number
  readonly capacity: number
  readonly paused: boolean
  /**
   * Resolves when everything this promotion started has finished.
   *
   * The watcher ignores it, because it has to keep polling while runs take
   * minutes. A one shot pass awaits it, or the process exits while the work it
   * just started is still going.
   */
  readonly settled: Promise<void>
}

/** What the scheduler needs of a run: claimed already, now go and do it. */
export type RunWork = (entry: QueueEntry, lease: string) => Promise<void> | void

/**
 * Fills every free slot, and not one more.
 *
 * Claiming is synchronous and the work is not awaited, which is the only way
 * the ceiling means anything: a run lasts minutes and can sit at a gate for
 * days, so awaiting it here would fill one slot per pass and leave the rest
 * idle until the next poll. The first version did exactly that, and the test
 * missed it because it stubbed the work with a synchronous claim.
 */
export function promoteQueued(
  db: Database,
  config: Config,
  work: RunWork,
): Promotion {
  const capacity = config.maxParallelRuns
  const started: QueueEntry[] = []
  const inFlight: Promise<void>[] = []
  if (config.queuePaused) {
    return {
      started,
      running: runningCount(db),
      capacity,
      paused: true,
      settled: Promise.resolve(),
    }
  }
  // The claim itself enforces the ceiling, so this loop ends when the database
  // says there is no room rather than on a count this function read earlier.
  for (;;) {
    const claimed = claimNextQueued(db, capacity)
    if (claimed === undefined) {
      break
    }
    started.push(claimed.entry)
    // Invoked inside an async function rather than handed to Promise.resolve,
    // because `work` throwing synchronously would otherwise escape before
    // there is a promise to catch it on, taking the whole poll tick with it.
    const running = (async () => work(claimed.entry, claimed.lease))().catch(
      (error: unknown) => {
        // The work is responsible for settling its own row; this is the last
        // resort so a rejection cannot take the poller down with it.
        log.error('a started run rejected', {
          repo: claimed.entry.repo,
          subject: `${claimed.entry.kind}#${claimed.entry.number}`,
          error: error instanceof Error ? error.message : String(error),
        })
      },
    )
    inFlight.push(running)
  }
  const nowRunning = runningCount(db)
  if (started.length > 0) {
    log.info('started queued work', {
      started: started.length,
      running: nowRunning,
      capacity,
    })
  }
  return {
    started,
    running: nowRunning,
    capacity,
    paused: false,
    settled: Promise.all(inFlight).then(() => undefined),
  }
}
