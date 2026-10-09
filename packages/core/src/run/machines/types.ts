import type { Analysis, Review } from '@/run/stations/schemas'

/**
 * Everything the machine decides with, and nothing it cannot write down.
 *
 * Context is persisted as JSON on every transition, so it holds the shape of
 * the run rather than the means of performing it. The worktree, the database
 * and the config are looked up by run id when an actor starts.
 */
export interface IssueWorkContext {
  readonly runId: string
  readonly repo: string
  readonly issueNumber: number
  readonly maxRevisions: number
  readonly revision: number
  /**
   * Which plan this run is working to.
   *
   * Separate from revision because they mean different things: a revision is
   * another pass at the implementation against the same plan, a generation is
   * a new plan because the issue itself changed.
   */
  readonly planGeneration: number
  readonly analysis?: Analysis
  readonly review?: Review
  readonly implementerReport: string
  readonly reviewWorktree?: string
  readonly outcome?: IssueWorkOutcome
  /** The issue text this run was planned against, for the premise region. */
  readonly premiseBody: string
  /** How often the premise is rechecked. Lowered by tests. */
  readonly premiseIntervalMs?: number
  /** Whether this run's policy asks a person to approve the plan. */
  readonly planGated?: boolean
  /**
   * Whether the analyst leads with what it does not know.
   *
   * Carried into the context because the analyst's prompt is built inside the
   * machine, and this is the only thing that distinguishes talking it through
   * from planning: the same gate, reached with questions rather than a guess.
   */
  readonly asksFirst?: boolean
  /** The gate currently being waited on, if any. */
  readonly gateId?: string
  /**
   * The reply being answered, while one is.
   *
   * Held in context rather than re-read by the actor so the turn answers the
   * message that triggered it, even if another arrives while it runs.
   */
  readonly pendingReply?: {
    readonly entryId: string
    readonly question: string
  }
  /**
   * The reply a turn was last spent on.
   *
   * The keeper re-announces a pending reply on every tick, because only the
   * machine knows whether it is already mid answer. This is what stops that
   * re-announcement buying a second turn, and what stops a failed answer
   * retrying in a loop.
   */
  readonly repliedTo?: string
  /** How often a parked run rechecks its gate. Lowered by tests. */
  readonly gatePollMs?: number
}

/**
 * How a run ended, for every ending the machine owns.
 *
 * Delivery is not here: the machine stops at an approved verdict and pushing
 * is the caller's job, so the two can be reasoned about separately.
 */
export type IssueWorkOutcome =
  | { readonly kind: 'stopped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly error: string }

export interface IssueWorkInput {
  readonly runId: string
  readonly repo: string
  readonly issueNumber: number
  readonly maxRevisions: number
  /** The issue text this run is planned against. */
  readonly premiseBody: string
  /** How often the premise is rechecked. Lowered by tests. */
  readonly premiseIntervalMs?: number
  /** Whether this run's policy asks a person to approve the plan. */
  readonly planGated?: boolean
  /** Whether the analyst leads with its questions rather than a plan. */
  readonly asksFirst?: boolean
  /** How often a parked run rechecks its gate. Lowered by tests. */
  readonly gatePollMs?: number
}

/**
 * Every state the work region can report, and the closed vocabulary of
 * `machine_snapshots.value`.
 *
 * The column is queried rather than merely stored: `unfinishedRuns` filters it
 * against `FINAL` to decide what to resume. A state that reports something
 * outside this list corrupts that query, so the list is asserted by a test
 * rather than kept in step by hand.
 */
export const WORK_STATES = [
  'planning',
  'gatingPlan',
  'implementing',
  'reviewing',
  'judging',
  'approved',
  'finished',
] as const
export type WorkState = (typeof WORK_STATES)[number]

/** What a parked run is doing inside the gate. Never persisted, never queried. */
const GATE_ACTIVITIES = ['waiting', 'answering'] as const
export type GateActivity = (typeof GATE_ACTIVITIES)[number]

/**
 * Which state the work region is in.
 *
 * The machine is parallel, so its value is an object with a branch per region.
 * Callers only ever care about the work one; the premise region's state is an
 * implementation detail of watching.
 *
 * A compound work state reports its own name rather than its substate, because
 * this string is written to `machine_snapshots.value` and compared against
 * `FINAL`. Returning the substate would change what a queried column says
 * without a migration saying so, and returning `String(value)` for an object,
 * which is what this did before any state had children, silently writes
 * "[object Object]" into it.
 */
export function workState(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  const work = (value as { work?: unknown } | null)?.work
  if (typeof work === 'string') {
    return work
  }
  if (typeof work === 'object' && work !== null) {
    const [name] = Object.keys(work)
    if (name !== undefined) {
      return name
    }
  }
  return String(value)
}

/**
 * Whether a parked run is idle or mid reply, or neither because it is not
 * parked.
 *
 * Separate from `workState` on purpose: this is for a surface to render, and
 * keeping it out of the persisted value is what lets the gate grow substates
 * without touching a column anything queries.
 */
export function gateActivity(value: unknown): GateActivity | undefined {
  const work = (value as { work?: unknown } | null)?.work
  const inner = (work as Record<string, unknown> | null)?.gatingPlan
  return GATE_ACTIVITIES.find((activity) => activity === inner)
}
