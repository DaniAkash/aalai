import { assign, setup, stateIn } from 'xstate'
import { analyst, implementer, premise, reviewer } from './actors'
import {
  analysisReady,
  entered,
  revisionStarted,
  verdictReached,
} from './announce'
import { initialContext } from './context'
import type { IssueWorkEvent } from './events'
import { gateKeeper } from './gateActor'
import { guards } from './guards'
import { messageOf, stopReason } from './outcome'
import { startAFreshPlan } from './replan'
import type { IssueWorkContext, IssueWorkInput } from './types'

export const issueWorkMachine = setup({
  types: {
    context: {} as IssueWorkContext,
    input: {} as IssueWorkInput,
    events: {} as IssueWorkEvent,
  },
  actors: { analyst, implementer, reviewer, premise, gateKeeper },
  guards,
}).createMachine({
  id: 'issueWork',
  type: 'parallel',
  context: ({ input }) => initialContext(input),
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
              reason: event.reason || 'the premise expired',
            }),
          }),
        },
        PREMISE_REPLAN: {
          target: '.planning',
          actions: assign({
            ...startAFreshPlan,
            // The rewritten text becomes the premise, or the watcher keeps
            // comparing against what the run started with and replans forever.
            premiseBody: ({ context, event }) =>
              'body' in event
                ? event.body || context.premiseBody
                : context.premiseBody,
          }),
        },
      },
      states: {
        planning: {
          entry: ({ context }) => entered(context, 'analyst'),
          invoke: {
            src: 'analyst',
            input: ({ context }) => ({
              runId: context.runId,
              planGeneration: context.planGeneration,
            }),
            // Both paths announce, so neither can forget: the criteria are the
            // contract, and anything watching should have them when they exist
            // rather than learning them from the verdict at the end.
            onDone: [
              {
                target: 'gatingPlan',
                guard: 'planNeedsApproval',
                actions: [
                  assign({ analysis: ({ event }) => event.output }),
                  ({ context, event }) => analysisReady(context, event.output),
                ],
              },
              {
                target: 'implementing',
                actions: [
                  assign({ analysis: ({ event }) => event.output }),
                  ({ context, event }) => analysisReady(context, event.output),
                ],
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

        /**
         * Parked, waiting for a person, with nothing in flight.
         *
         * The one state a restart costs nothing: restoring re-runs invocations,
         * and this invocation only listens. Re-entering it re-reads the row,
         * which is the source of truth anyway.
         */
        gatingPlan: {
          invoke: {
            src: 'gateKeeper',
            input: ({ context }) => ({
              runId: context.runId,
              repo: context.repo,
              issue: context.issueNumber,
              kind: 'plan',
              ...(context.gatePollMs === undefined
                ? {}
                : { pollMs: context.gatePollMs }),
            }),
          },
          on: {
            GATE_OPENED: {
              actions: assign({ gateId: ({ event }) => event.gateId }),
            },
            GATE_ANSWERED: [
              {
                target: 'implementing',
                guard: 'answeredApproved',
              },
              {
                // A new plan rather than another revision of the old one, the
                // same shape a rewritten issue takes.
                target: 'planning',
                guard: 'answeredChanges',
                actions: assign({
                  ...startAFreshPlan,
                  gateId: () => undefined,
                }),
              },
              {
                target: 'finished',
                actions: assign({
                  outcome: ({ event }) => ({
                    kind: 'stopped' as const,
                    reason:
                      ('reason' in event ? event.reason : '') ||
                      'the plan was rejected',
                  }),
                }),
              },
            ],
            // The artifact moved under the question. Ask again at the version
            // that now stands rather than stalling on one nobody can answer.
            GATE_SUPERSEDED: {
              target: 'gatingPlan',
              actions: assign({ gateId: () => undefined }),
              reenter: true,
            },
          },
        },

        implementing: {
          entry: ({ context }) => {
            entered(context, 'implementer')
            revisionStarted(context)
          },
          invoke: {
            src: 'implementer',
            input: ({ context }) => ({
              runId: context.runId,
              revision: context.revision,
              planGeneration: context.planGeneration,
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
          entry: ({ context }) => entered(context, 'reviewer'),
          invoke: {
            src: 'reviewer',
            input: ({ context }) => ({
              runId: context.runId,
              revision: context.revision,
              planGeneration: context.planGeneration,
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
          entry: ({ context }) => verdictReached(context),
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
