import type { Seen, Signal } from '@/run/prSignals'

/** What a pull request run was started with. */
export interface PrInput {
  readonly runId: string
  readonly repo: string
  readonly prNumber: number
  /** The issue this came from, so its plan is context for a revision. */
  readonly issueNumber?: number
  /** How often the pull request is looked at. Lowered by tests. */
  readonly pollMs?: number
  /** How long signals gather before being acted on. Lowered by tests. */
  readonly windowMs?: number
  /** How long a pull request nobody answers is left before it is closed. */
  readonly staleAfterMs?: number
  /** What the two allowances are, read from settings rather than assumed here. */
  readonly maxCiFixes: number
  readonly maxRevisions: number
}

export interface PrContext {
  readonly runId: string
  readonly repo: string
  readonly prNumber: number
  readonly issueNumber?: number
  readonly pollMs?: number
  readonly windowMs?: number
  readonly staleAfterMs?: number
  readonly maxCiFixes: number
  readonly maxRevisions: number
  /** Signals gathered but not yet acted on, and when the window opened. */
  readonly openedAt?: string
  readonly pending: readonly Signal[]
  /** Spent separately, because a reviewer and a red check are different wrongs. */
  readonly ciFixes: number
  readonly revisions: number
  /** What the last look established, so the next one knows what is new. */
  readonly looked: boolean
  readonly headSha: string
  readonly baseSha: string
  readonly lastCommentId: number
  readonly failedChecks: readonly string[]
  /** The commit this run pushed, which is how a hand written one is noticed. */
  readonly pushedSha: string
  /** The last verdict on a failure, held only long enough to say it. */
  readonly verdict?: import('@/run/stations/schemas').FaultVerdict
  readonly outcome?: PrOutcome
}

export type PrOutcome =
  /** Somebody else is working on the branch, so this stopped touching it. */
  | { readonly kind: 'handedBack'; readonly author: string }
  /** The budget ran out, with the reason a person will read. */
  | { readonly kind: 'exhausted'; readonly why: string }
  /** Merged, or closed by somebody. Either way there is nothing left to watch. */
  | { readonly kind: 'closed'; readonly state: string }
  /** Checks are green and nobody is asking for anything. */
  | { readonly kind: 'settled' }
  /** Closed after nobody came back to it. */
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly error: string }

export type PrEvent =
  /**
   * One look, with what it found and what it now knows.
   *
   * The `seen` travels with it because the watch is torn down and rebuilt every
   * time the machine changes state, so anything it learned privately would be
   * forgotten. That is how the first version kept re-establishing a baseline it
   * had already established, and reporting the same pull request's base as
   * having moved on every re-entry.
   */
  | { readonly type: 'PR_CLOSED'; readonly state: string }
  | {
      readonly type: 'LOOKED'
      readonly signals: readonly Signal[]
      readonly seen: Seen
    }
  | { readonly type: 'WINDOW_CLOSED' }
  | { readonly type: 'NOTHING_LEFT' }
  | { readonly type: 'STALE' }
