import { assign, setup } from 'xstate'
import { emit } from '@/events/bus'
import { logger } from '@/lib/log'
import type { CommitOutcome } from '@/run/commit'
import { reviewGate } from '@/run/gate'
import type { Analysis, Review } from '@/run/stations/schemas'
import { analyst, implementer, reviewer } from './actors'

const log = logger('pipeline')

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
  readonly analysis?: Analysis
  readonly review?: Review
  readonly implementerReport: string
  readonly reviewWorktree?: string
  readonly outcome?: IssueWorkOutcome
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

interface IssueWorkInput {
  readonly runId: string
  readonly repo: string
  readonly issueNumber: number
  readonly maxRevisions: number
}

export const issueWorkMachine = setup({
  types: {
    context: {} as IssueWorkContext,
    input: {} as IssueWorkInput,
  },
  actors: { analyst, implementer, reviewer },
  guards: {
    committed: (_, params: { commit: CommitOutcome }) =>
      params.commit === 'committed',
    approved: ({ context }) =>
      context.review !== undefined &&
      context.analysis !== undefined &&
      reviewGate(context.review, context.analysis).ok,
    rejected: ({ context }) => context.review?.verdict === 'reject',
    revisable: ({ context }) =>
      context.review?.verdict === 'request_changes' &&
      context.revision < context.maxRevisions,
  },
}).createMachine({
  id: 'issueWork',
  initial: 'planning',
  context: ({ input }) => ({
    runId: input.runId,
    repo: input.repo,
    issueNumber: input.issueNumber,
    maxRevisions: input.maxRevisions,
    revision: 0,
    implementerReport: '',
  }),
  states: {
    planning: {
      entry: ({ context }) =>
        emit({
          type: 'stage.entered',
          runId: context.runId,
          stage: 'analyst',
          at: Date.now(),
        }),
      invoke: {
        src: 'analyst',
        input: ({ context }) => ({ runId: context.runId }),
        onDone: {
          target: 'implementing',
          actions: assign({ analysis: ({ event }) => event.output }),
        },
        onError: {
          target: 'finished',
          actions: assign({
            outcome: ({ event }) => ({
              kind: 'failed' as const,
              error: messageOf(event.error),
            }),
          }),
        },
      },
    },

    implementing: {
      entry: ({ context }) => {
        emit({
          type: 'stage.entered',
          runId: context.runId,
          stage: 'implementer',
          at: Date.now(),
        })
        if (context.revision > 0 && context.review !== undefined) {
          emit({
            type: 'revision.started',
            runId: context.runId,
            attempt: context.revision,
            findings: context.review.blocking_findings,
            at: Date.now(),
          })
        }
      },
      invoke: {
        src: 'implementer',
        input: ({ context }) => ({
          runId: context.runId,
          revision: context.revision,
          ...(context.review === undefined ? {} : { review: context.review }),
        }),
        onDone: [
          {
            guard: {
              type: 'committed',
              params: ({ event }) => ({ commit: event.output.commit }),
            },
            target: 'reviewing',
            actions: assign({
              implementerReport: ({ event }) => event.output.report,
            }),
          },
          {
            target: 'finished',
            actions: assign({
              outcome: ({ event }) => ({
                kind: 'stopped' as const,
                reason:
                  event.output.commit === 'no-changes'
                    ? 'the agent made no file changes'
                    : 'the agent changed only build or dependency output',
              }),
            }),
          },
        ],
        onError: {
          target: 'finished',
          actions: assign({
            outcome: ({ event }) => ({
              kind: 'failed' as const,
              error: messageOf(event.error),
            }),
          }),
        },
      },
    },

    reviewing: {
      entry: ({ context }) =>
        emit({
          type: 'stage.entered',
          runId: context.runId,
          stage: 'reviewer',
          at: Date.now(),
        }),
      invoke: {
        src: 'reviewer',
        input: ({ context }) => ({
          runId: context.runId,
          revision: context.revision,
        }),
        onDone: {
          target: 'judging',
          actions: assign({
            review: ({ event }) => event.output.review,
            reviewWorktree: ({ event }) => event.output.worktree,
          }),
        },
        onError: {
          target: 'finished',
          actions: assign({
            outcome: ({ event }) => ({
              kind: 'failed' as const,
              error: messageOf(event.error),
            }),
          }),
        },
      },
    },

    judging: {
      entry: ({ context }) => {
        const review = context.review
        if (review === undefined) return
        const passed = review.criteria_results.filter((r) => r.pass).length
        log.info('verdict', {
          verdict: review.verdict,
          criteria: `${passed}/${review.criteria_results.length}`,
          blocking: review.blocking_findings.length,
        })
        emit({
          type: 'review.verdict',
          runId: context.runId,
          verdict: review.verdict,
          results: review.criteria_results,
          at: Date.now(),
        })
      },
      always: [
        { guard: 'approved', target: 'approved' },
        {
          guard: 'rejected',
          target: 'finished',
          actions: assign({
            outcome: ({ context }) => ({
              kind: 'stopped' as const,
              reason: `the reviewer rejected the approach: ${context.review?.summary ?? ''}`,
            }),
          }),
        },
        {
          guard: 'revisable',
          target: 'implementing',
          actions: assign({ revision: ({ context }) => context.revision + 1 }),
        },
        {
          target: 'finished',
          actions: assign({
            outcome: ({ context }) => ({
              kind: 'stopped' as const,
              reason: stopReason(context),
            }),
          }),
        },
      ],
    },

    approved: { type: 'final' },
    finished: { type: 'final' },
  },
})

/**
 * Why a run stopped when the verdict was neither an approval nor a rejection.
 *
 * An approve that fails the gate is a malformed approval rather than a change
 * request: sending it back would ask the implementer to fix nothing.
 */
function stopReason(context: IssueWorkContext): string {
  if (context.review?.verdict === 'approve' && context.analysis !== undefined) {
    const gate = reviewGate(context.review, context.analysis)
    if (!gate.ok) {
      return gate.reason
    }
  }
  return `the reviewer still requested changes after ${context.maxRevisions} revisions`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
