import type { Database } from 'bun:sqlite'
import type { Config } from '@/config'
import { logger } from '@/lib/log'
import { renewClaim } from '@/watch/state'

const log = logger('pr')

/**
 * Keeps a claim alive while something long lived runs, and gives it up if it
 * cannot.
 *
 * Shared by the two things that hold a `pr` subject for a long time: keeping our
 * own pull request alive and reviewing somebody else's. The review had no
 * renewal at first, which meant a trust gate left open past the stale window
 * could be taken over and a second review started on the same pull request, both
 * of them able to open gates and run tests.
 *
 * A renewal that fails is not a warning. Somebody else holds the claim, so the
 * one that lost stops rather than finishing what it was doing.
 */
export function holdReviewClaim(
  db: Database,
  config: Config,
  repo: string,
  prNumber: number,
  lease: string,
): { signal: AbortSignal; release: () => void } {
  const lost = new AbortController()
  const every = Math.max(60_000, (config.staleClaimMinutes * 60_000) / 3)
  const timer = setInterval(() => {
    if (renewClaim(db, repo, prNumber, lease, 'pr')) {
      return
    }
    log.warn('this run lost its claim, stopping it', { repo, pr: prNumber })
    clearInterval(timer)
    lost.abort()
  }, every)
  return {
    signal: lost.signal,
    release: () => {
      clearInterval(timer)
    },
  }
}
