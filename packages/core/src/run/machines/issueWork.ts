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
import { replier } from './replyActor'
import type { IssueWorkContext, IssueWorkInput } from './types'

export const issueWorkMachine = setup({
  types: {
    context: {} as IssueWorkContext,
    input: {} as IssueWorkInput,
    events: {} as IssueWorkEvent,
  },
  actors: { analyst, implementer, reviewer, premise, gateKeeper, replier },
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
              ...(context.asksFirst === undefined
                ? {}
                : { asksFirst: context.asksFirst }),
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
         * Parked, waiting for a person, who may talk before deciding.
         *
         * The gate keeper is invoked here rather than on a child, so it survives
         * both substates and an answer arriving mid conversation is still
         * handled by this state: approving while the analyst is halfway through
         * a sentence is ordinary, not exceptional.
         */
        gatingPlan: {
          id: 'gatingPlan',
          initial: 'waiting',
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
          states: {
            waiting: {
              on: {
                REPLY_RECEIVED: {
                  target: 'answering',
                  guard: 'replyIsNew',
                  actions: assign({
                    pendingReply: ({ event }) => ({
                      entryId: event.entryId,
                      question: event.question,
                    }),
                  }),
                },
              },
            },
            /**
             * The analyst answers, and the gate stays open at the same version.
             *
             * Nothing here distinguishes talking from revising: a reply that
             * revises writes a new plan version, which the gate keeper reports as
             * a supersede and the parent already handles.
             */
            answering: {
              invoke: {
                src: 'replier',
                input: ({ context }) => ({
                  runId: context.runId,
                  entryId: context.pendingReply?.entryId ?? '',
                  question: context.pendingReply?.question ?? '',
                }),
                onDone: [
                  {
                    /*
                     * A reply that revised the plan re-enters the gate rather
                     * than returning to waiting beside it.
                     *
                     * Re-entering is what runs the keeper's start again, and
                     * that is the only thing that retires the question asked
                     * about the version which no longer stands and opens one
                     * pinned to the bytes that do. Returning to `waiting` left
                     * the run on the old gate while the context held the new
                     * plan, so approving it approved one plan and built
                     * another.
                     */
                    target: '#gatingPlan',
                    reenter: true,
                    guard: 'replyRevisedThePlan',
                    actions: assign({
                      analysis: ({ context, event }) =>
                        event.output.analysis ?? context.analysis,
                      repliedTo: ({ context }) => context.pendingReply?.entryId,
                      pendingReply: () => undefined,
                      gateId: () => undefined,
                    }),
                  },
                  {
                    target: 'waiting',
                    actions: assign({
                      repliedTo: ({ context }) => context.pendingReply?.entryId,
                      pendingReply: () => undefined,
                    }),
                  },
                ],
                // A failed answer leaves the gate open rather than failing the
                // run: the maintainer can still decide without one.
                onError: {
                  target: 'waiting',
                  actions: assign({
                    repliedTo: ({ context }) => context.pendingReply?.entryId,
                    pendingReply: () => undefined,
                  }),
                },
              },
            },
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
                  pendingReply: () => undefined,
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
              actions: assign({
                gateId: () => undefined,
                pendingReply: () => undefined,
              }),
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
