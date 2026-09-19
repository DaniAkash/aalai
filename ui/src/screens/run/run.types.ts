/**
 * The event contract, mirrored from the service.
 *
 * Kept as a hand-written mirror only until the Hono app exists; once it does
 * these come from the RPC client so there is one definition rather than two.
 */
export type Stage = 'workspace' | 'analyst' | 'implementer' | 'commit' | 'reviewer' | 'deliver'

export type StationId = Extract<Stage, 'analyst' | 'implementer' | 'reviewer'>

export type StageState = 'queued' | 'working' | 'done' | 'stopped'

export interface CriterionResult {
  readonly criterion: string
  readonly pass: boolean
  readonly evidence: string
}

export type RunEvent =
  | { readonly type: 'run.started'; readonly repo: string; readonly issue: number; readonly title: string }
  | { readonly type: 'stage.entered'; readonly stage: Stage }
  | { readonly type: 'workspace.ready'; readonly branch: string; readonly base: string; readonly conventions: readonly string[] }
  | { readonly type: 'analysis.ready'; readonly steps: number; readonly criteria: readonly string[] }
  | { readonly type: 'agent.tool'; readonly station: StationId; readonly tool: string }
  | { readonly type: 'agent.text'; readonly station: StationId; readonly text: string }
  | { readonly type: 'commit.made'; readonly sha: string; readonly attempt: number }
  | { readonly type: 'review.verdict'; readonly verdict: 'approve' | 'request_changes' | 'reject'; readonly results: readonly CriterionResult[] }
  | { readonly type: 'run.delivered'; readonly prUrl: string; readonly branch: string }
  | { readonly type: 'run.stopped'; readonly reason: string }

/** What a station shows: its state, what it is doing, and what it produced. */
export interface StationView {
  readonly id: Stage
  readonly label: string
  readonly state: StageState
  readonly tools: readonly string[]
  readonly notes: readonly string[]
  /** The fact it produced, shown once it is done. */
  readonly output: string | null
  /** What it hands to the next station. */
  readonly handoff: string | null
}

export interface RunView {
  readonly repo: string
  readonly issue: number
  readonly title: string
  readonly stations: readonly StationView[]
  readonly criteria: readonly string[]
  readonly results: readonly CriterionResult[]
  readonly verdict: 'approve' | 'request_changes' | 'reject' | null
  readonly prUrl: string | null
  readonly stoppedReason: string | null
  readonly activeStation: StationId | null
}
