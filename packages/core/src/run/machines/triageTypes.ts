import type { GateDecision } from '@/modules/db/schema/schema'
import type { Triage } from '@/run/stations/schemas'

/** What a triage run was started with. */
export interface TriageInput {
  readonly runId: string
  readonly repo: string
  readonly issueNumber: number
  /** How often a parked run rechecks its gate. Lowered by tests. */
  readonly gatePollMs?: number
  /** The wait on a reporter, lowered by tests which cannot wait a fortnight. */
  readonly reporterPollMs?: number
  readonly nudgeAfterMs?: number
  readonly staleAfterMs?: number
}

export interface TriageContext {
  readonly runId: string
  readonly repo: string
  readonly issueNumber: number
  readonly gatePollMs?: number
  /** What the classifier decided, once it has. */
  readonly triage?: Triage
  /**
   * Which pass through the classifier this is.
   *
   * A reclassification is a new judgement rather than a retry of the old one,
   * so it needs its own attempt: keyed on this, the way a replan is keyed on
   * the plan generation.
   */
  readonly generation: number
  /**
   * What a person said was wrong with the classification.
   *
   * Prose rather than a classification chosen from a list, because "this is a
   * question, they are asking how to configure it" says more than the word
   * does, and it is written into the discussion the classifier already reads.
   */
  readonly correction?: string
  readonly gateId?: string
  readonly pendingReply?: {
    readonly entryId: string
    readonly question: string
  }
  readonly repliedTo?: string
  /** When the reporter was asked, which the wait measures everything against. */
  readonly askedAt?: string
  /** Lowered by tests, which cannot wait a fortnight. */
  readonly nudgeAfterMs?: number
  readonly staleAfterMs?: number
  readonly reporterPollMs?: number
  readonly outcome?: TriageOutcome
}

/**
 * How a triage run ended, which is what the caller acts on.
 *
 * `handOff` is the only one that leads to code being written. The rest are
 * finished business: something was said, or deliberately not said.
 */
export type TriageOutcome =
  | { readonly kind: 'handOff'; readonly triage: Triage }
  | { readonly kind: 'answered'; readonly decision: GateDecision }
  | { readonly kind: 'escalated' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly error: string }

/** What the classifier is asked for, and what a reclassification carries back. */
export type TriageEvent =
  | { type: 'GATE_OPENED'; gateId: string }
  | {
      type: 'GATE_ANSWERED'
      gateId: string
      decision: GateDecision
      reason: string
    }
  | { type: 'GATE_SUPERSEDED'; gateId: string }
  | { type: 'REPLY_RECEIVED'; entryId: string; question: string }
  | { type: 'REPORTER_REPLIED'; body: string }
  | { type: 'REPORTER_NUDGED' }
  | { type: 'REPORTER_SILENT' }
