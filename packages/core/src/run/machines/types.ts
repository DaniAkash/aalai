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
}

/**
 * Which state the work region is in.
 *
 * The machine is parallel, so its value is an object with a branch per region.
 * Callers only ever care about the work one; the premise region's state is an
 * implementation detail of watching.
 */
export function workState(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  const work = (value as { work?: unknown } | null)?.work
  return typeof work === 'string' ? work : String(value)
}
