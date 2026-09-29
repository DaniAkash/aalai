import { logger } from '@/lib/log'

const log = logger('watch')

/**
 * The loop every watch in here shares.
 *
 * Nothing pushes to a desktop application, so anything waiting on the outside
 * world asks on an interval. All of them then want the same three things: a
 * first look straight away rather than after one interval, a failed request
 * that does not end the watch, and a teardown that stops both the timer and any
 * look already in flight.
 *
 * The caller gets a `stopped` it can read, because the interesting failure is a
 * request that returns after the watch was torn down and reports a fact about a
 * run that has moved on.
 */
export function pollEvery(
  intervalMs: number,
  look: (stopped: () => boolean) => Promise<void>,
  what: string,
): () => void {
  let stopped = false
  const isStopped = () => stopped

  const tick = (): void => {
    void look(isStopped).catch((error: unknown) => {
      // A watch outlives any one failed request, and the next tick asks again
      // from the same remembered position.
      log.debug(`could not ${what}`, {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  tick()
  const timer = setInterval(tick, intervalMs)

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
