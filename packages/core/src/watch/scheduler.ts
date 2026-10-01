import type { Database } from 'bun:sqlite'
import type { Config } from '@/config'
import { logger } from '@/lib/log'
import { nextQueued, type QueueEntry, runningCount } from '@/watch/queue'

const log = logger('scheduler')

export interface Promotion {
  readonly started: QueueEntry[]
  readonly running: number
  readonly capacity: number
  readonly paused: boolean
}

/**
 * Starts queued work up to the ceiling, and not one run past it.
 *
 * The ceiling is the only thing standing between a queue of thirty and a
 * laptop that stops responding, so this is the single place a run is allowed
 * to begin. Nothing else in the factory may start one.
 */
export async function promoteQueued(
  db: Database,
  config: Config,
  start: (entry: QueueEntry) => Promise<void> | void,
): Promise<Promotion> {
  const capacity = config.maxParallelRuns
  const started: QueueEntry[] = []
  if (config.queuePaused) {
    return { started, running: runningCount(db), capacity, paused: true }
  }
  // Re-read the count each time around rather than counting locally: starting
  // a run is what makes it running, and a start that failed must not consume a
  // slot that nothing is using.
  while (runningCount(db) < capacity) {
    const next = nextQueued(db)
    if (next === undefined) {
      break
    }
    try {
      await start(next)
      started.push(next)
    } catch (error) {
      log.error('could not start a queued run', {
        repo: next.repo,
        subject: `${next.kind}#${next.number}`,
        error: error instanceof Error ? error.message : String(error),
      })
      // Left for the next pass rather than retried here, so one unstartable
      // run cannot spin this loop forever.
      break
    }
  }
  const running = runningCount(db)
  if (started.length > 0) {
    log.info('started queued work', {
      started: started.length,
      running,
      capacity,
    })
  }
  return { started, running, capacity, paused: false }
}
