import type { CommitOutcome } from '@/run/commit'
import { reviewGate } from '@/run/gate'
import type { IssueWorkEvent } from './events'
import type { IssueWorkContext } from './types'

type Args = { context: IssueWorkContext; event: IssueWorkEvent }

/**
 * Every condition the work region branches on, in one place.
 *
 * Plain predicates rather than state, so they read as the rules they are and
 * the machine file stays about shape.
 */
export const guards = {
  committed: (_: unknown, params: { commit: CommitOutcome }) =>
    params.commit === 'committed',
  approved: ({ context }: Args) =>
    context.review !== undefined &&
    context.analysis !== undefined &&
    reviewGate(context.review, context.analysis).ok,
  rejected: ({ context }: Args) => context.review?.verdict === 'reject',
  revisable: ({ context }: Args) =>
    context.review?.verdict === 'request_changes' &&
    context.revision < context.maxRevisions,
  /** Whether this repository's policy asks a person before any code is written. */
  planNeedsApproval: ({ context }: Args) => context.planGated === true,
  /**
   * Whether the turn that just finished rewrote the plan.
   *
   * A revision has to re-enter the gate so the old question is retired and a new
   * one is pinned to the bytes that now stand. A reply that only answered leaves
   * the gate exactly as it was.
   */
  replyRevisedThePlan: ({ event }: Args) =>
    'output' in event &&
    typeof event.output === 'object' &&
    event.output !== null &&
    (event.output as { analysis?: unknown }).analysis !== undefined,
  /**
   * Whether this reply is one a turn has not already been spent on.
   *
   * The keeper re-announces a pending reply on every tick, because only the
   * machine knows whether it is mid answer and a reply arriving during a turn
   * would otherwise be dropped by a state with no handler and never mentioned
   * again. This is what keeps that re-announcement from buying a second turn,
   * and what stops a failed answer retrying in a loop.
   */
  replyIsNew: ({ context, event }: Args) =>
    event.type === 'REPLY_RECEIVED' &&
    event.entryId !== '' &&
    event.entryId !== context.repliedTo,
  answeredApproved: ({ event }: Args) =>
    event.type === 'GATE_ANSWERED' && event.decision === 'approved',
  answeredChanges: ({ event }: Args) =>
    event.type === 'GATE_ANSWERED' && event.decision === 'changes',
}
