import { assign, setup, stateIn } from 'xstate'
import { emit } from '@/events/bus'
import { logger } from '@/lib/log'
import type { CommitOutcome } from '@/run/commit'
import { reviewGate } from '@/run/gate'
import { analyst, implementer, premise, reviewer } from './actors'
import { gateKeeper } from './gateActor'
import { messageOf, stopReason } from './outcome'
import type { IssueWorkContext, IssueWorkInput } from './types'

const log = logger('pipeline')

export const issueWorkMachine = setup({
  types: {
    context: {} as IssueWorkContext,
    input: {} as IssueWorkInput,
  },
  actors: { analyst, implementer, reviewer, premise, gateKeeper },
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
    planNeedsApproval: ({ context }) => context.planGated === true,
    answeredApproved: (_, params: { decision: string }) =>
      params.decision === 'approved',
    answeredChanges: (_, params: { decision: string }) =>
      params.decision === 'changes',
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
    planGeneration: 0,
    implementerReport: '',
    ...(input.planGated === undefined ? {} : { planGated: input.planGated }),
    ...(input.gatePollMs === undefined ? {} : { gatePollMs: input.gatePollMs }),
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
            // A new plan, not another revision of the old one. The generation
            // moves so the analyst runs a fresh attempt rather than returning
            // the plan it already recorded.
            planGeneration: ({ context }) => context.planGeneration + 1,
            // The implementation cycle starts over: the issue is a different
            // request now, so a verdict about the old one is not guidance, and
            // the revisions already spent were spent on something else.
            revision: () => 0,
            review: () => undefined,
            implementerReport: () => '',
            // The rewritten text becomes the premise, or the watcher keeps
            // comparing against what the run started with and replans forever.
            premiseBody: ({ context, event }) =>
              String((event as { body?: string }).body ?? context.premiseBody),
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
            input: ({ context }) => ({
              runId: context.runId,
              planGeneration: context.planGeneration,
            }),
            onDone: [
              {
                target: 'gatingPlan',
                guard: 'planNeedsApproval',
                actions: assign({ analysis: ({ event }) => event.output }),
              },
              {
                target: 'implementing',
                actions: assign({ analysis: ({ event }) => event.output }),
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
              actions: assign({
                gateId: ({ event }) =>
                  String((event as { gateId?: string }).gateId ?? ''),
              }),
            },
            GATE_ANSWERED: [
              {
                target: 'implementing',
                guard: {
                  type: 'answeredApproved',
                  params: ({ event }) => ({
                    decision: String((event as { decision?: string }).decision),
                  }),
                },
              },
              {
                // A new plan rather than another revision of the old one, the
                // same shape a rewritten issue takes.
                target: 'planning',
                guard: {
                  type: 'answeredChanges',
                  params: ({ event }) => ({
                    decision: String((event as { decision?: string }).decision),
                  }),
                },
                actions: assign({
                  planGeneration: ({ context }) => context.planGeneration + 1,
                  revision: () => 0,
                  review: () => undefined,
                  implementerReport: () => '',
                  gateId: () => undefined,
                }),
              },
              {
                target: 'finished',
                actions: assign({
                  outcome: ({ event }) => ({
                    kind: 'stopped' as const,
                    reason:
                      String((event as { reason?: string }).reason ?? '') ||
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
