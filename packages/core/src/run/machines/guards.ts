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
  answeredApproved: ({ event }: Args) =>
    event.type === 'GATE_ANSWERED' && event.decision === 'approved',
  answeredChanges: ({ event }: Args) =>
    event.type === 'GATE_ANSWERED' && event.decision === 'changes',
}
