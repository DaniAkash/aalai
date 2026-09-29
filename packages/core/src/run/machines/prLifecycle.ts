import { assign, setup } from 'xstate'
import { exhaustedBecause, mayFixCi, mayRevise } from '@/run/budgets'
import { ready, type Upshot, upshotOf } from '@/run/prCollect'
import { isOurFault } from '@/run/stations/schemas'
import { failureReporter, faultClassifier } from './prActors'
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

/** What this batch amounts to, asked in one place so every guard agrees. */
function upshot(context: PrContext): Upshot {
  return upshotOf({
    openedAt: context.openedAt ?? '',
    signals: context.pending,
  })
}

/**
 * Whether there is budget for what this batch asks.
 *
 * Asked of the two allowances separately. A batch carrying a failing check and
 * a review comment needs both, and running out of one must not quietly spend
 * the other.
 */
function affordable(context: PrContext): boolean {
  const asked = upshot(context)
  if (asked.kind !== 'revise') {
    return true
  }
  const spent = { ciFixes: context.ciFixes, revisions: context.revisions }
  const allowance = {
    maxCiFixes: context.maxCiFixes,
    maxRevisions: context.maxRevisions,
  }
  return (
    (asked.failing.length === 0 || mayFixCi(spent, allowance)) &&
    (asked.asked.length === 0 || mayRevise(spent, allowance))
  )
}

const watchInput = ({ context }: { context: PrContext }) => ({
  repo: context.repo,
  prNumber: context.prNumber,
  seen: {
    headSha: context.headSha,
    baseSha: context.baseSha,
    lastCommentId: context.lastCommentId,
    failedChecks: context.failedChecks,
    pushedSha: context.pushedSha,
  },
  ...(context.pollMs === undefined ? {} : { pollMs: context.pollMs }),
})

export const prLifecycle = setup({
  types: {
    context: {} as PrContext,
    input: {} as PrInput,
    events: {} as PrEvent,
  },
  actors: { prWatch, faultClassifier, failureReporter },
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
  context: ({ input }) => ({
    runId: input.runId,
    repo: input.repo,
    prNumber: input.prNumber,
    maxCiFixes: input.maxCiFixes,
    maxRevisions: input.maxRevisions,
    ...(input.issueNumber === undefined
      ? {}
      : { issueNumber: input.issueNumber }),
    ...(input.pollMs === undefined ? {} : { pollMs: input.pollMs }),
    ...(input.windowMs === undefined ? {} : { windowMs: input.windowMs }),
    pending: [],
    ciFixes: 0,
    revisions: 0,
    headSha: '',
    baseSha: '',
    lastCommentId: 0,
    failedChecks: [],
    pushedSha: '',
  }),
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
        SIGNALS: {
          target: 'collecting',
          actions: assign({
            openedAt: () => new Date().toISOString(),
            pending: ({ event }) =>
              event.type === 'SIGNALS' ? [...event.signals] : [],
          }),
        },
        PR_GONE: {
          target: 'done',
          actions: assign({ outcome: () => ({ kind: 'settled' as const }) }),
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
        SIGNALS: {
          actions: assign({
            pending: ({ context, event }) =>
              event.type === 'SIGNALS'
                ? [...context.pending, ...event.signals]
                : context.pending,
          }),
        },
        PR_GONE: {
          target: 'done',
          actions: assign({ outcome: () => ({ kind: 'settled' as const }) }),
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
        {
          // A batch of review comments with no failing check. Answering those
          // is the next piece of work; until it exists this says so rather
          // than dropping them.
          target: 'done',
          actions: assign({
            outcome: () => ({
              kind: 'exhausted' as const,
              why: 'a review comment needs answering and that is not built yet',
            }),
          }),
        },
      ],
    },

    /**
     * Whether the change caused the failure, before any budget is spent.
     *
     * The state most likely to be skipped and most costly to skip. Without it
     * somebody else's outage consumes the allowance that exists for a reviewer
     * disagreeing, and a correct pull request is abandoned over a flaky runner.
     */
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
            // Ours. Fixing it is the next piece of work, and until it exists
            // this stops and says so rather than looping back to watch a
            // failure it has decided is its own.
            target: 'done',
            actions: assign({
              outcome: ({ event }) => ({
                kind: 'exhausted' as const,
                why: `the checks fail because of this change (${event.output.summary}) and fixing that automatically is not built yet`,
              }),
            }),
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
