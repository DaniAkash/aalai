import { assign, setup } from 'xstate'
import { isActionable, mayBeAnsweredPublicly } from '@/run/stations/schemas'
import { gateKeeper } from './gateActor'
import { replier } from './replyActor'
import { reporterWatch } from './reporterActor'
import {
  binder,
  classifier,
  corrector,
  deliverer,
  staleCloser,
} from './triageActors'
import type { TriageContext, TriageEvent, TriageInput } from './triageTypes'

/**
 * Decides whether an issue is worth acting on, before any code is considered.
 *
 * A machine of its own rather than a state inside `issueWork`, because four of
 * its outcomes never reach code: a question is answered, a duplicate is cross
 * referenced, noise is closed, and a security report is escalated in silence.
 * Folded in, `issueWork` would be a machine that can finish four different ways
 * before its own purpose begins, carrying a context that means nothing for most
 * of its life.
 *
 * The gate is the same gate. `gatingTriage` invokes the same keeper as
 * `gatingPlan`, with the same substates and the same conversation, because a
 * second keeper would be a second thing to keep correct and the first one has
 * already been through two rounds of review.
 */
export const triageMachine = setup({
  types: {
    context: {} as TriageContext,
    input: {} as TriageInput,
    events: {} as TriageEvent,
  },
  actors: {
    classifier,
    gateKeeper,
    replier,
    deliverer,
    binder,
    corrector,
    reporterWatch,
    staleCloser,
  },
  guards: {
    /**
     * Whether anything may be said about this at all.
     *
     * Read from the classification rather than from whether a reply happens to
     * exist, so a classifier that ignores its instructions and drafts one still
     * cannot have it said.
     *
     * Read from the event and not from the context, which is the part that
     * matters and is easy to get wrong: a guard runs before the actions on its
     * own transition, so the classification is still absent from the context at
     * the moment this is asked. Reading the context there sends every security
     * report to a gate, which is the exact failure this guard exists to
     * prevent.
     */
    mustStaySilent: ({ event }: { event: TriageEvent }) => {
      const output = (event as { output?: unknown }).output
      return (
        output !== undefined &&
        !mayBeAnsweredPublicly(output as NonNullable<TriageContext['triage']>)
      )
    },
    approvedAndActionable: ({
      context,
      event,
    }: {
      context: TriageContext
      event: TriageEvent
    }) =>
      event.type === 'GATE_ANSWERED' &&
      event.decision === 'approved' &&
      context.triage !== undefined &&
      isActionable(context.triage),
    answeredReclassify: ({ event }: { event: TriageEvent }) =>
      event.type === 'GATE_ANSWERED' && event.decision === 'reclassify',
    /** Whether what just went out was a question rather than an answer. */
    askedForMore: ({ context }: { context: TriageContext }) =>
      context.triage !== undefined && context.triage.missing.length > 0,
    replyIsNew: ({
      context,
      event,
    }: {
      context: TriageContext
      event: TriageEvent
    }) =>
      event.type === 'REPLY_RECEIVED' &&
      event.entryId !== '' &&
      event.entryId !== context.repliedTo,
    replyRevised: ({ event }: { event: TriageEvent }) =>
      'output' in event &&
      typeof event.output === 'object' &&
      event.output !== null &&
      (event.output as { analysis?: unknown }).analysis !== undefined,
  },
}).createMachine({
  id: 'triage',
  initial: 'classifying',
  context: ({ input }) => ({
    runId: input.runId,
    repo: input.repo,
    issueNumber: input.issueNumber,
    generation: 0,
    ...(input.gatePollMs === undefined ? {} : { gatePollMs: input.gatePollMs }),
    ...(input.reporterPollMs === undefined
      ? {}
      : { reporterPollMs: input.reporterPollMs }),
    ...(input.nudgeAfterMs === undefined
      ? {}
      : { nudgeAfterMs: input.nudgeAfterMs }),
    ...(input.staleAfterMs === undefined
      ? {}
      : { staleAfterMs: input.staleAfterMs }),
  }),
  states: {
    classifying: {
      invoke: {
        src: 'classifier',
        input: ({ context }) => ({
          runId: context.runId,
          issueNumber: context.issueNumber,
          generation: context.generation,
        }),
        onDone: [
          {
            /*
             * Straight past the gate, and past everything else.
             *
             * A security report has nothing to approve: approving would be
             * approving a public reply, and there is no public reply. It ends
             * here and is surfaced privately, which is the absence of a
             * transition rather than a special one.
             */
            target: 'escalated',
            guard: 'mustStaySilent',
            actions: assign({
              triage: ({ event }) => event.output,
              outcome: () => ({ kind: 'escalated' as const }),
            }),
          },
          {
            target: 'gatingTriage',
            actions: assign({ triage: ({ event }) => event.output }),
          },
        ],
        onError: {
          target: 'finished',
          actions: assign({
            outcome: ({ event }) => ({
              kind: 'failed' as const,
              error:
                event.error instanceof Error
                  ? event.error.message
                  : String(event.error),
            }),
          }),
        },
      },
    },

    /** Parked on the report, which a person may also talk to. */
    gatingTriage: {
      id: 'gatingTriage',
      initial: 'waiting',
      invoke: {
        src: 'gateKeeper',
        input: ({ context }) => ({
          runId: context.runId,
          repo: context.repo,
          issue: context.issueNumber,
          kind: 'triage' as const,
          ...(context.gatePollMs === undefined
            ? {}
            : { pollMs: context.gatePollMs }),
        }),
      },
      states: {
        /**
         * Says which question the queued intents belong to, then waits.
         *
         * The classifier queues its drafted reply before the gate exists,
         * because the gate is opened on the report it just wrote. Binding is
         * what lets delivery refuse anything a person has not released, and it
         * runs the moment the gate is announced rather than when something is
         * about to be sent.
         */
        binding: {
          invoke: {
            src: 'binder',
            input: ({ context }) => ({
              runId: context.runId,
              gateId: context.gateId ?? '',
            }),
            onDone: 'waiting',
            onError: 'waiting',
          },
        },
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
        answering: {
          invoke: {
            src: 'replier',
            input: ({ context }) => ({
              runId: context.runId,
              entryId: context.pendingReply?.entryId ?? '',
              question: context.pendingReply?.question ?? '',
            }),
            onDone: {
              target: 'waiting',
              actions: assign({
                repliedTo: ({ context }) => context.pendingReply?.entryId,
                pendingReply: () => undefined,
              }),
            },
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
          // Binding follows the opening rather than preceding it. The gate does
          // not exist when this state is entered: the keeper opens it and says
          // so, and only then is there a question for the queued intents to
          // belong to.
          target: '.binding',
          actions: assign({ gateId: ({ event }) => event.gateId }),
        },
        GATE_ANSWERED: [
          {
            target: 'handingOff',
            guard: 'approvedAndActionable',
            actions: assign({
              outcome: ({ context }) => ({
                kind: 'handOff' as const,
                triage: context.triage as NonNullable<TriageContext['triage']>,
              }),
            }),
          },
          {
            // A correction rather than a rejection: the classification was
            // wrong and the person said what it should be.
            target: 'recording',
            guard: 'answeredReclassify',
            actions: assign({
              generation: ({ context }) => context.generation + 1,
              correction: ({ event }) =>
                'reason' in event ? event.reason : '',
              gateId: () => undefined,
              pendingReply: () => undefined,
              repliedTo: () => undefined,
            }),
          },
          {
            // Approved but not actionable, or rejected. Either way a person
            // has answered and whatever was queued may now go out.
            target: 'delivering',
            actions: assign({
              outcome: ({ event }) => ({
                kind: 'answered' as const,
                decision:
                  event.type === 'GATE_ANSWERED' ? event.decision : 'approved',
              }),
            }),
          },
        ],
        GATE_SUPERSEDED: {
          target: 'gatingTriage',
          actions: assign({
            gateId: () => undefined,
            pendingReply: () => undefined,
          }),
          reenter: true,
        },
      },
    },

    /**
     * Writes the correction down where the next classification will read it.
     *
     * A correction is prose rather than a new classification chosen from a
     * list: "this is a question, they are asking how to configure it" says more
     * than the word `question` does, and the discussion is already the place a
     * person and a station talk. So it is appended there and the classifier
     * reads it on its next pass, which needs no new column and no parsing.
     */
    recording: {
      invoke: {
        src: 'corrector',
        input: ({ context }) => ({
          runId: context.runId,
          correction: context.correction ?? '',
        }),
        onDone: 'classifying',
        onError: 'classifying',
      },
    },

    /**
     * Says what the person released, and nothing more.
     *
     * A failure here leaves the answer standing and the intents queued rather
     * than failing the run: the decision was made and is not undone by a
     * comment that did not post.
     */
    delivering: {
      invoke: {
        src: 'deliverer',
        input: ({ context }) => ({ runId: context.runId }),
        onDone: [
          {
            /*
             * The question went out, so now someone has to answer it.
             *
             * This is the only outcome that does not end the run: aalai has
             * asked a stranger for something and has no idea whether they will
             * ever reply.
             */
            target: 'awaitingReporter',
            guard: 'askedForMore',
            actions: assign({ askedAt: () => new Date().toISOString() }),
          },
          { target: 'finished' },
        ],
        onError: 'finished',
      },
    },

    /**
     * Waiting on the reporter, for as long as that takes.
     *
     * Not a gate: nothing is being asked of the maintainer, and presenting it
     * as answerable would be a row that looks actionable and is not.
     */
    awaitingReporter: {
      invoke: {
        src: 'reporterWatch',
        input: ({ context }) => ({
          runId: context.runId,
          repo: context.repo,
          issue: context.issueNumber,
          askedAt: context.askedAt ?? new Date().toISOString(),
          ...(context.reporterPollMs === undefined
            ? {}
            : { pollMs: context.reporterPollMs }),
          ...(context.nudgeAfterMs === undefined
            ? {}
            : { nudgeAfterMs: context.nudgeAfterMs }),
          ...(context.staleAfterMs === undefined
            ? {}
            : { staleAfterMs: context.staleAfterMs }),
        }),
      },
      on: {
        // Waking is not proceeding. What they said may make the issue less
        // actionable rather than more, so it is classified again rather than
        // carried forward.
        REPORTER_REPLIED: {
          target: 'classifying',
          actions: assign({
            generation: ({ context }) => context.generation + 1,
            gateId: () => undefined,
            askedAt: () => undefined,
          }),
        },
        // The nudge is queued rather than posted, like everything else, and
        // rides on the gate that already released the original question.
        REPORTER_NUDGED: { target: 'delivering', reenter: true },
        REPORTER_SILENT: {
          target: 'closing',
          actions: assign({ outcome: () => ({ kind: 'stale' as const }) }),
        },
      },
    },

    /** Closes an issue nobody came back to, with a comment saying why. */
    closing: {
      entry: assign({ outcome: () => ({ kind: 'stale' as const }) }),
      invoke: {
        src: 'staleCloser',
        input: ({ context }) => ({ runId: context.runId }),
        onDone: 'delivering',
        onError: 'finished',
      },
    },

    handingOff: { type: 'final' },
    escalated: { type: 'final' },
    finished: { type: 'final' },
  },
})
