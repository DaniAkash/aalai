/**
 * What a run tells anything watching it.
 *
 * One discriminated union, emitted at the points the pipeline already logs.
 * The logger stays a subscriber, so the terminal output is unchanged and the
 * UI is additive rather than a replacement.
 */
import type { GateDecision } from '@/modules/db/schema/schema'

export type Stage =
  | 'workspace'
  | 'classifier'
  | 'analyst'
  | 'implementer'
  | 'reviewer'
  | 'deliver'

export type StationId = Extract<
  Stage,
  'classifier' | 'analyst' | 'implementer' | 'reviewer'
>

/** One file a step changed, as the thread shows it. */
export interface FileChangeEvent {
  readonly path: string
  readonly kind: 'added' | 'modified' | 'deleted'
  readonly additions: number
  readonly deletions: number
}

export interface CriterionResultEvent {
  readonly criterion: string
  readonly pass: boolean
  readonly evidence: string
}

export interface Base {
  readonly runId: string
  /** Milliseconds since the epoch, stamped at emit. */
  readonly at: number
}

export type RunEvent = Base &
  (
    | {
        readonly type: 'gate.refused'
        readonly repo: string
        readonly issue: number
        readonly reason: string
      }
    | {
        readonly type: 'run.started'
        readonly repo: string
        readonly issue: number
        readonly title: string
      }
    | { readonly type: 'stage.entered'; readonly stage: Stage }
    | {
        /** A run picked back up after the process that started it went away. */
        readonly type: 'run.resumed'
        readonly state: string
      }
    | {
        readonly type: 'workspace.ready'
        readonly branch: string
        readonly base: string
        readonly conventions: readonly string[]
      }
    | {
        readonly type: 'analysis.ready'
        readonly steps: number
        readonly criteria: readonly string[]
      }
    | {
        /** A station began a numbered step of the plan in force. */
        readonly type: 'step.started'
        readonly station: StationId
        readonly stepIndex: number
        /**
         * What the step does, where the plan is not to hand.
         *
         * The thread can name a step by looking it up in the plan. A work list
         * row showing forty subjects cannot, so the station says it here.
         */
        readonly label?: string
      }
    | {
        /**
         * How far through a step it is, in units the step chose.
         *
         * The one thing a long step has to keep saying. Without it a step that
         * takes five minutes is indistinguishable from one that has hung, and
         * the interface has nothing to animate but a spinner.
         */
        readonly type: 'step.progress'
        readonly station: StationId
        readonly stepIndex: number
        /** What is being counted, shown verbatim: `bun test`, `files read`. */
        readonly label: string
        readonly unit: string
        readonly done: number
        readonly total: number
      }
    | {
        readonly type: 'step.finished'
        readonly station: StationId
        readonly stepIndex: number
        readonly summary: string
        readonly files: readonly FileChangeEvent[]
      }
    | {
        /** Which of the repository's own instruction files a station read. */
        readonly type: 'context.read'
        readonly station: StationId
        readonly files: readonly {
          readonly path: string
          readonly found: boolean
          readonly bytes: number
        }[]
      }
    | {
        readonly type: 'review.answered'
        readonly station: StationId
        readonly threadId: string
        readonly answer: string
        readonly commitSha: string | null
      }
    | {
        readonly type: 'agent.tool'
        readonly station: StationId
        readonly tool: string
      }
    | {
        readonly type: 'agent.text'
        readonly station: StationId
        readonly text: string
      }
    | {
        readonly type: 'commit.made'
        readonly sha: string
        readonly attempt: number
      }
    | {
        readonly type: 'review.verdict'
        readonly verdict: 'approve' | 'request_changes' | 'reject'
        readonly results: readonly CriterionResultEvent[]
      }
    | {
        readonly type: 'revision.started'
        readonly attempt: number
        readonly findings: readonly string[]
      }
    | {
        readonly type: 'run.delivered'
        readonly prUrl: string
        readonly branch: string
      }
    | {
        /**
         * A run parked and is waiting for a person.
         *
         * Distinct from `gate.refused`, which is the trust screen turning an
         * issue away before any run exists.
         */
        readonly type: 'gate.opened'
        readonly gateId: string
        readonly kind: string
        readonly repo: string
        readonly issue: number
        /** What is being asked, when the gate has no artifact to point at. */
        readonly summary?: string
      }
    | {
        readonly type: 'gate.answered'
        readonly gateId: string
        readonly decision: GateDecision
        /** Which surface answered: the app, a terminal, a comment. */
        readonly answeredOn: string
      }
    | {
        /**
         * Something was said in a subject's discussion.
         *
         * Carries who said it and not what they said, for the same reason the
         * database stores paths rather than prose: a client refetches the thread,
         * and an event stream that replayed bodies would be a second copy of the
         * record that could disagree with it.
         */
        readonly type: 'conversation.appended'
        readonly gateId: string
        readonly author: string
        readonly role: 'maintainer' | 'station' | 'reporter'
      }
    | { readonly type: 'run.stopped'; readonly reason: string }
    | { readonly type: 'run.failed'; readonly error: string }
  )

/** Everything emitted for one run, newest last. */
export interface RunLog {
  readonly runId: string
  readonly events: readonly RunEvent[]
}
