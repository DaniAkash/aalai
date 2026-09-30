import type { ExecutionVerdict } from '@/run/executionTrust'

/** What a review of somebody else's pull request starts with. */
export interface ReviewInput {
  readonly runId: string
  readonly repo: string
  readonly prNumber: number
  readonly title: string
  /** How often a parked review rechecks its gate. Lowered by tests. */
  readonly gatePollMs?: number
}

export interface ReviewContext {
  readonly runId: string
  readonly repo: string
  readonly prNumber: number
  readonly title: string
  readonly gatePollMs?: number
  /** Whether the code may run without asking, once Q2 has been asked. */
  readonly execution?: ExecutionVerdict
  /** The head the review and any trust decision belong to. */
  readonly headSha: string
  readonly gateId?: string
  /** The branch to check out, once there is a reason to check anything out. */
  readonly headRef?: string
  /** What the suite said, when it was allowed to run. */
  readonly tests?: {
    readonly ran: boolean
    readonly passed: boolean
    readonly output: string
    readonly why?: string
  }
  readonly outcome?: ReviewOutcome
}

export type ReviewOutcome =
  /** Too large to review usefully, with the reason said out loud. */
  | { readonly kind: 'declined'; readonly why: string }
  /** Read but never run, because nobody released it. That is a complete result. */
  | { readonly kind: 'readOnly' }
  /** Read and run. */
  | { readonly kind: 'reviewed' }
  /** The head moved under the review, so what it read no longer exists. */
  | { readonly kind: 'stale' }
  /** Merged or closed while it was being read. */
  | { readonly kind: 'gone' }
  | { readonly kind: 'failed'; readonly error: string }

export type ReviewEvent =
  | { readonly type: 'GATE_OPENED'; readonly gateId: string }
  | {
      readonly type: 'GATE_ANSWERED'
      readonly gateId: string
      readonly decision: string
      readonly reason: string
    }
  | { readonly type: 'GATE_SUPERSEDED'; readonly gateId: string }
  | { readonly type: 'HEAD_MOVED'; readonly headSha: string }
  | { readonly type: 'PR_CLOSED'; readonly state: string }
