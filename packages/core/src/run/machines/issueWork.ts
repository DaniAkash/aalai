import { assign, setup, stateIn } from 'xstate'
import { emit } from '@/events/bus'
import { logger } from '@/lib/log'
import type { CommitOutcome } from '@/run/commit'
import { reviewGate } from '@/run/gate'
import { analyst, implementer, premise, reviewer } from './actors'
import { messageOf, stopReason } from './outcome'
import type { IssueWorkContext, IssueWorkInput } from './types'

const log = logger('pipeline')

export const issueWorkMachine = setup({
  types: {
    context: {} as IssueWorkContext,
    input: {} as IssueWorkInput,
  },
  actors: { analyst, implementer, reviewer, premise },
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
  type: 'parallel',
  context: ({ input }) => ({
    runId: input.runId,
    repo: input.repo,
    issueNumber: input.issueNumber,
    maxRevisions: input.maxRevisions,
    revision: 0,
    implementerReport: '',
    premiseBody: input.premiseBody,
    ...(input.premiseIntervalMs === undefined
      ? {}
      : { premiseIntervalMs: input.premiseIntervalMs }),
  }),
  states: {
    /**
     * Watches for the ground moving, for the machine's whole life.
     *
     * A region of its own because the alternative is a transition out of every
     * station for every way the world can change, which is unreadable and easy
     * to forget one of.
     */
    premise: {
      initial: 'watching',
      states: {
        watching: {
          invoke: {
            src: 'premise',
            input: ({ context }) => ({
              runId: context.runId,
              body: context.premiseBody,
              ...(context.premiseIntervalMs === undefined
                ? {}
                : { intervalMs: context.premiseIntervalMs }),
            }),
          },
          // Stops asking once the work is over. A parallel machine is only
          // done when every region is, so this is also what lets a run finish
          // at all. Keyed to the work region's state rather than to the
          // outcome, because an approved run sets no outcome.
          always: [
            { guard: stateIn({ work: 'approved' }), target: 'done' },
            { guard: stateIn({ work: 'finished' }), target: 'done' },
          ],
        },
        done: { type: 'final' },
      },
    },
    work: {
      initial: 'planning',
      on: {
        PREMISE_ABORT: {
          target: '.finished',
          actions: assign({
            outcome: ({ event }) => ({
              kind: 'stopped' as const,
              reason: String(
                (event as { reason?: string }).reason ?? 'the premise expired',
              ),
            }),
          }),
        },
        PREMISE_REPLAN: {
          target: '.planning',
          actions: assign({
            // The plan was made against text that no longer exists, so it is
            // replanned rather than abandoned. The analyst runs again, which
            // its attempt record allows because the revision moves with it.
            revision: ({ context }) => context.revision + 1,
          }),
        },
      },
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
              ...(context.review === undefined
                ? {}
                : { review: context.review }),
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
                reviewWorktree: ({ event, context }) =>
                  event.output.worktree ?? context.reviewWorktree,
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
              actions: assign({
                revision: ({ context }) => context.revision + 1,
              }),
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
    },
  },
})
