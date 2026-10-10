import { assign, setup } from 'xstate'
import { exhaustedBecause } from '@/run/budgets'
import { ready } from '@/run/prCollect'
import { isOurFault } from '@/run/stations/schemas'
import {
  ciFixer,
  failureReporter,
  faultClassifier,
  reviewAnswerer,
} from './prActors'
import {
  affordable,
  rememberSeen,
  startingFrom,
  upshot,
  watchInput,
} from './prRules'
import type { PrContext, PrEvent, PrInput } from './prTypes'
import { prWatch } from './prWatchActor'

/**
 * A pull request that already exists, kept alive.
 *
 * The third machine, and the first whose subject changes without being asked.
 * Everything before this happens because the factory did something; this
 * happens because a check finished, or a person read the diff, or somebody
 * merged into the base. That is why it is a machine rather than a state at the
 * end of the one that opened the pull request: it starts from a thing in the
 * world, is driven entirely from outside, and may run for days.
 */

export const prLifecycle = setup({
  types: {
    context: {} as PrContext,
    input: {} as PrInput,
    events: {} as PrEvent,
  },
  actors: {
    prWatch,
    faultClassifier,
    failureReporter,
    ciFixer,
    reviewAnswerer,
  },
  guards: {
    windowClosed: ({ context }: { context: PrContext }) =>
      context.openedAt !== undefined &&
      ready(
        { openedAt: context.openedAt, signals: context.pending },
        Date.now(),
        context.windowMs,
      ),
    handedBack: ({ context }: { context: PrContext }) =>
      upshot(context).kind === 'stop',
    needsRebase: ({ context }: { context: PrContext }) =>
      upshot(context).kind === 'rebase',
    nothingAsked: ({ context }: { context: PrContext }) =>
      upshot(context).kind === 'nothing',
    outOfBudget: ({ context }: { context: PrContext }) => !affordable(context),
    checksFailed: ({ context }: { context: PrContext }) => {
      const asked = upshot(context)
      return asked.kind === 'revise' && asked.failing.length > 0
    },
  },
}).createMachine({
  id: 'prLifecycle',
  context: ({ input }) => startingFrom(input),
  initial: 'watching',
  states: {
    /**
     * Nothing is being asked of anybody.
     *
     * Deliberately not a gate. A pull request being kept alive is work in
     * progress, and putting it in the inbox as a question would be a row that
     * looks answerable and is not.
     */
    watching: {
      invoke: { src: 'prWatch', input: watchInput },
      on: {
        LOOKED: [
          {
            target: 'collecting',
            guard: ({ event }) =>
              event.type === 'LOOKED' && event.signals.length > 0,
            actions: assign({
              openedAt: () => new Date().toISOString(),
              pending: ({ event }) =>
                event.type === 'LOOKED' ? [...event.signals] : [],
              ...rememberSeen,
            }),
          },
          {
            // A quiet look. Nothing to act on, but what it established still
            // has to be kept, or the next one establishes it again and reports
            // the pull request's own base as having moved.
            actions: assign(rememberSeen),
          },
        ],
        PR_CLOSED: {
          target: 'done',
          actions: assign({
            outcome: ({ event }) => ({
              kind: 'closed' as const,
              state: event.type === 'PR_CLOSED' ? event.state : 'CLOSED',
            }),
          }),
        },
      },
    },

    /**
     * Letting everything that is arriving arrive.
     *
     * A reviewer commenting while a check is failing is the ordinary case, and
     * answering each separately means two revisions against one branch where
     * the second undoes the first.
     */
    collecting: {
      invoke: { src: 'prWatch', input: watchInput },
      after: {
        // Rechecked rather than waited out. The guard reads the timestamp, so
        // a run restored mid window does not begin the window again.
        1000: [
          { target: 'deciding', guard: 'windowClosed' },
          { target: 'collecting', reenter: true },
        ],
      },
      on: {
        LOOKED: {
          actions: assign({
            pending: ({ context, event }) =>
              event.type === 'LOOKED'
                ? [...context.pending, ...event.signals]
                : context.pending,
            ...rememberSeen,
          }),
        },
        PR_CLOSED: {
          target: 'done',
          actions: assign({
            outcome: ({ event }) => ({
              kind: 'closed' as const,
              state: event.type === 'PR_CLOSED' ? event.state : 'CLOSED',
            }),
          }),
        },
      },
    },

    /** What the batch amounts to, in the order of consequence. */
    deciding: {
      always: [
        {
          // First, because every other answer is a push and this forbids one.
          target: 'done',
          guard: 'handedBack',
          actions: assign({
            outcome: ({ context }) => {
              const touched = context.pending.find(
                (s) => s.kind === 'branch_touched',
              )
              return {
                kind: 'handedBack' as const,
                author:
                  touched?.kind === 'branch_touched'
                    ? touched.author
                    : 'someone',
              }
            },
          }),
        },
        {
          target: 'watching',
          guard: 'nothingAsked',
          actions: assign({ pending: () => [], openedAt: () => undefined }),
        },
        {
          // The base moved. Not implemented as a rebase yet, and it says so
          // rather than pretending the batch was handled: silently clearing it
          // would leave a pull request that can never be merged looking healthy.
          target: 'done',
          guard: 'needsRebase',
          actions: assign({
            outcome: () => ({
              kind: 'exhausted' as const,
              why: 'the base branch moved and this cannot rebase itself yet',
            }),
          }),
        },
        {
          target: 'done',
          guard: 'outOfBudget',
          actions: assign({
            outcome: ({ context }) => ({
              kind: 'exhausted' as const,
              why:
                exhaustedBecause(
                  { ciFixes: context.ciFixes, revisions: context.revisions },
                  {
                    maxCiFixes: context.maxCiFixes,
                    maxRevisions: context.maxRevisions,
                  },
                ) ?? 'there was nothing left to try',
            }),
          }),
        },
        { target: 'classifyingFailure', guard: 'checksFailed' },
        // A batch of review comments with no failing check. The reviewer
        // answers them, and pushes whatever answering them changed.
        { target: 'answeringReview' },
      ],
    },

    /**
     * Whether the change caused the failure, before any budget is spent.
     *
     * The state most likely to be skipped and most costly to skip. Without it
     * somebody else's outage consumes the allowance that exists for a reviewer
     * disagreeing, and a correct pull request is abandoned over a flaky runner.
     */
    /**
     * The reviewer answers what the review asked.
     *
     * Back to watching afterwards rather than finishing, because answering a
     * review is not the end of a pull request: the push it may have made
     * starts the checks again, and a reviewer who reads the answer may say
     * something else.
     */
    answeringReview: {
      // Counted on the way in, the same as a ci fix, and against the revisions
      // allowance rather than that one: a reviewer asking for something else
      // and a check going red are different kinds of wrong. Without this the
      // budget never advances, and answering a review pushes a commit which a
      // bot reviewer answers with more comments, which is a loop that spends a
      // laptop rather than one that ends.
      entry: assign({ revisions: ({ context }) => context.revisions + 1 }),
      invoke: {
        src: 'reviewAnswerer',
        input: ({ context }) => {
          const asked = upshot(context)
          return {
            runId: context.runId,
            prNumber: context.prNumber,
            comments:
              asked.kind === 'revise'
                ? asked.asked.flatMap((signal) =>
                    signal.kind === 'comments' ? signal.comments : [],
                  )
                : [],
          }
        },
        onDone: {
          target: 'watching',
          actions: assign({
            // Remembered so the push this just made is not read back on the
            // next look as somebody else touching the branch.
            pushedSha: ({ context, event }) =>
              event.output.pushedSha ?? context.pushedSha,
            pending: () => [],
          }),
        },
        onError: {
          target: 'done',
          actions: assign({
            outcome: () => ({
              kind: 'failed' as const,
              error: 'could not answer the review',
            }),
          }),
        },
      },
    },

    classifyingFailure: {
      invoke: {
        src: 'faultClassifier',
        input: ({ context }) => {
          const asked = upshot(context)
          return {
            runId: context.runId,
            prNumber: context.prNumber,
            failing: asked.kind === 'revise' ? asked.failing : [],
          }
        },
        onDone: [
          {
            target: 'saying',
            guard: ({ event }) => !isOurFault(event.output),
            actions: assign({ verdict: ({ event }) => event.output }),
          },
          {
            // Ours, and there is budget, so fix it.
            target: 'fixing',
            actions: assign({ verdict: ({ event }) => event.output }),
          },
        ],
        onError: {
          target: 'done',
          actions: assign({
            outcome: () => ({
              kind: 'failed' as const,
              error: 'could not work out why the checks failed',
            }),
          }),
        },
      },
    },

    /**
     * Making the failing check pass, then watching what that did.
     *
     * A fix is spent here rather than when the failure was noticed, so a
     * classification that decided the failure was somebody else's costs
     * nothing. The commit it pushes is remembered, which is what lets the next
     * look tell this run's own push from a person's.
     */
    fixing: {
      entry: assign({ ciFixes: ({ context }) => context.ciFixes + 1 }),
      invoke: {
        src: 'ciFixer',
        input: ({ context }) => {
          const asked = upshot(context)
          return {
            runId: context.runId,
            prNumber: context.prNumber,
            failing: asked.kind === 'revise' ? asked.failing : [],
            why: context.verdict?.summary ?? 'the checks fail on this change',
            attempt: context.ciFixes,
          }
        },
        onDone: {
          target: 'watching',
          actions: assign({
            pushedSha: ({ event }) => event.output.pushedSha,
            pending: () => [],
            openedAt: () => undefined,
            verdict: () => undefined,
          }),
        },
        // A turn that changed nothing, or could not push, is not a fix. The
        // attempt is already spent, and saying so is better than going back to
        // watch a check fail for the same reason a third time.
        onError: {
          target: 'done',
          actions: assign({
            outcome: () => ({
              kind: 'failed' as const,
              error: 'tried to fix the failing checks and changed nothing',
            }),
          }),
        },
      },
    },

    /**
     * Saying a failure was not ours, then carrying on watching.
     *
     * Not the end of the run. Somebody else's outage gets fixed by somebody
     * else, and when it does the next look sees green.
     */
    saying: {
      invoke: {
        src: 'failureReporter',
        input: ({ context }) => ({
          runId: context.runId,
          prNumber: context.prNumber,
          verdict: context.verdict as NonNullable<PrContext['verdict']>,
        }),
        onDone: {
          target: 'watching',
          actions: assign({ pending: () => [], openedAt: () => undefined }),
        },
        onError: {
          target: 'done',
          actions: assign({
            outcome: () => ({
              kind: 'failed' as const,
              error: 'could not say why the checks were not ours',
            }),
          }),
        },
      },
    },

    done: { type: 'final' },
  },
})
