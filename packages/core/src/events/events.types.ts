/**
 * What a run tells anything watching it.
 *
 * One discriminated union, emitted at the points the pipeline already logs.
 * The logger stays a subscriber, so the terminal output is unchanged and the
 * UI is additive rather than a replacement.
 */
export type Stage =
  | 'workspace'
  | 'analyst'
  | 'implementer'
  | 'reviewer'
  | 'deliver'

export type StationId = Extract<Stage, 'analyst' | 'implementer' | 'reviewer'>

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
    | { readonly type: 'run.stopped'; readonly reason: string }
    | { readonly type: 'run.failed'; readonly error: string }
  )

/** Everything emitted for one run, newest last. */
export interface RunLog {
  readonly runId: string
  readonly events: readonly RunEvent[]
}
