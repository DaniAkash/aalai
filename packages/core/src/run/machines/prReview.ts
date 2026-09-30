import { assign, setup } from 'xstate'
import { gateKeeper } from './gateActor'
import {
  executionScreen,
  headWatch,
  sizer,
  staticReviewer,
} from './reviewActors'
import type { ReviewContext, ReviewEvent, ReviewInput } from './reviewTypes'

/**
 * Reviewing a pull request the factory did not write.
 *
 * The fourth machine, and the only one that reads code belonging to somebody
 * else. Its shape is decided by one fact established before it was built: no
 * permission mode prevents an agent running a shell command, so nothing that
 * asks an agent to behave can make reading a stranger's branch safe. The
 * contributor's code is therefore never checked out; the review reads a diff.
 *
 * The order of the states is the design. Sizing first, because it costs nothing
 * and a change nobody could review usefully should not consume an agent turn.
 * Then the static read, which is always safe. Only then the question of running
 * it, asked of a person who by then has a report to answer it with.
 */
export const prReview = setup({
  types: {
    context: {} as ReviewContext,
    input: {} as ReviewInput,
    events: {} as ReviewEvent,
  },
  actors: { sizer, executionScreen, staticReviewer, headWatch, gateKeeper },
  guards: {
    /** Whether the code may run without anybody being asked. */
    mayRun: ({ context }: { context: ReviewContext }) =>
      context.execution?.allowed === true,
    trustGranted: ({ event }: { event: ReviewEvent }) =>
      event.type === 'GATE_ANSWERED' && event.decision === 'approved',
  },
}).createMachine({
  id: 'prReview',
  context: ({ input }) => ({
    runId: input.runId,
    repo: input.repo,
    prNumber: input.prNumber,
    title: input.title,
    ...(input.gatePollMs === undefined ? {} : { gatePollMs: input.gatePollMs }),
    headSha: '',
  }),
  initial: 'sizing',
  states: {
    /** Cheapest first. No agent runs until a verdict could be worth reading. */
    sizing: {
      invoke: {
        src: 'sizer',
        input: ({ context }) => ({
          runId: context.runId,
          prNumber: context.prNumber,
        }),
        onDone: [
          {
            target: 'done',
            guard: ({ event }) => !event.output.reviewable,
            actions: assign({
              headSha: ({ event }) => event.output.headSha,
              outcome: ({ event }) => ({
                kind: 'declined' as const,
                why:
                  'why' in event.output ? event.output.why : 'it is too large',
              }),
            }),
          },
          {
            target: 'screening',
            actions: assign({ headSha: ({ event }) => event.output.headSha }),
          },
        ],
        onError: {
          target: 'done',
          actions: assign({
            outcome: () => ({
              kind: 'failed' as const,
              error: 'could not read the pull request',
            }),
          }),
        },
      },
    },

    /**
     * Whether this code may run, asked before the review rather than after.
     *
     * The answer changes what the review is asked for, not whether it happens:
     * a reviewer about to have the tests run for real should not spend its turn
     * guessing at what they would say.
     */
    screening: {
      invoke: {
        src: 'executionScreen',
        input: ({ context }) => ({
          runId: context.runId,
          prNumber: context.prNumber,
        }),
        onDone: {
          target: 'reading',
          actions: assign({ execution: ({ event }) => event.output }),
        },
        onError: {
          // Refused rather than assumed. Not knowing whether code may run is
          // the same as it not being allowed to.
          target: 'reading',
          actions: assign({
            execution: () => ({
              allowed: false as const,
              reason: 'whether this code may run could not be established',
            }),
          }),
        },
      },
    },

    /** Always safe, and always happens. Nothing is checked out to read it. */
    reading: {
      invoke: {
        src: 'staticReviewer',
        input: ({ context }) => ({
          runId: context.runId,
          prNumber: context.prNumber,
          title: context.title,
          willRun: context.execution?.allowed === true,
        }),
        onDone: [
          { target: 'checkingHead', guard: 'mayRun' },
          { target: 'askingToRun' },
        ],
        onError: {
          target: 'done',
          actions: assign({
            outcome: () => ({
              kind: 'failed' as const,
              error: 'the change could not be read',
            }),
          }),
        },
      },
    },

    /**
     * Waiting for a person to decide whether to run somebody else's code.
     *
     * The report is already written, which is the whole reason the review comes
     * first: a question about running code is unanswerable without knowing what
     * the code does.
     */
    askingToRun: {
      invoke: {
        src: 'gateKeeper',
        input: ({ context }) => ({
          runId: context.runId,
          repo: context.repo,
          issue: context.prNumber,
          kind: 'trust' as const,
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
          { target: 'checkingHead', guard: 'trustGranted' },
          {
            // Not a failure. A change read and not run is a complete result,
            // and the report stands on its own.
            target: 'done',
            actions: assign({ outcome: () => ({ kind: 'readOnly' as const }) }),
          },
        ],
        GATE_SUPERSEDED: {
          target: 'done',
          actions: assign({ outcome: () => ({ kind: 'stale' as const }) }),
        },
      },
    },

    /**
     * Whether the code that was read is still the code that is there.
     *
     * Checked immediately before running anything. A trust decision was granted
     * for a head, and a force push between the granting and the running means
     * the thing a person agreed to run no longer exists.
     */
    checkingHead: {
      invoke: {
        src: 'headWatch',
        input: ({ context }) => ({
          runId: context.runId,
          prNumber: context.prNumber,
          headSha: context.headSha,
        }),
        onDone: [
          {
            target: 'done',
            guard: ({ event }) => event.output.state !== 'OPEN',
            actions: assign({ outcome: () => ({ kind: 'gone' as const }) }),
          },
          {
            target: 'done',
            guard: ({ event }) => event.output.moved,
            actions: assign({ outcome: () => ({ kind: 'stale' as const }) }),
          },
          {
            // Running is the next piece of work. Until it exists this says so
            // rather than reporting a review that ran nothing as one that did.
            target: 'done',
            actions: assign({
              outcome: () => ({
                kind: 'failed' as const,
                error:
                  'the code was cleared to run and running it is not built yet',
              }),
            }),
          },
        ],
        onError: {
          target: 'done',
          actions: assign({
            outcome: () => ({
              kind: 'failed' as const,
              error: 'could not check whether the head had moved',
            }),
          }),
        },
      },
    },

    done: { type: 'final' },
  },
})
