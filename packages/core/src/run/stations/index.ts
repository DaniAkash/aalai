import type { Config } from '@/config'
import type { GhIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import { parseStationOutput } from '@/lib/structured'
import { toolSurfaceIsUp } from '@/modules/tools/endpoint'
import {
  buildAnalystPrompt,
  buildImplementerPrompt,
  buildReplyPrompt,
  buildReviewerPrompt,
  buildStationRules,
  buildTriagePrompt,
} from '@/prompts/stations'
import { runStation, type StationResult } from '@/run/station'
import {
  type Analysis,
  analysisSchema,
  type Review,
  reviewSchema,
  type Triage,
  triageSchema,
} from '@/run/stations/schemas'

const log = logger('stations')

class StationOutputError extends Error {
  constructor(station: string, detail: string) {
    super(
      `the ${station} returned output that does not match its schema: ${detail}`,
    )
    this.name = 'StationOutputError'
  }
}

/**
 * Runs a station and validates its structured output, retrying once.
 *
 * The retry exists because a station both works and reports, and an agent that
 * revised itself mid-reply occasionally leaves the JSON malformed. One
 * clarified retry is cheap; a second would just be a slower way to fail.
 */
/**
 * A station whose turn has to produce a structured value.
 *
 * A tool call is the first choice: it was validated on the way in and recorded
 * on disk, so there is nothing to parse and nothing to disagree about. Parsing
 * the reply is the fallback, for the headless path and for a turn where the
 * tool surface did not come up. The retry asks for whichever of the two that
 * turn was told to use.
 */
async function structuredStation<T>(
  station: string,
  input: Parameters<typeof runStation>[0],
  schema: Parameters<typeof parseStationOutput<T>>[1],
  fromTools: (result: StationResult) => T | undefined,
): Promise<{ value: T; result: StationResult }> {
  let result = await runStation(input)
  let recorded = fromTools(result)
  if (recorded !== undefined) {
    return { value: recorded, result }
  }

  let parsed = parseStationOutput(result.text, schema)
  if (!parsed.ok) {
    log.warn(`${station} recorded nothing usable, retrying once`, {
      error: parsed.error,
      hadTools: toolSurfaceIsUp(),
    })
    result = await runStation({
      ...input,
      task: `${input.task}\n\nYour previous reply recorded nothing usable: ${parsed.error}. Do it again with the same content, recording it the way you were asked to above.`,
    })
    recorded = fromTools(result)
    if (recorded !== undefined) {
      return { value: recorded, result }
    }
    parsed = parseStationOutput(result.text, schema)
  }
  if (!parsed.ok) {
    throw new StationOutputError(station, parsed.error)
  }
  return { value: parsed.value, result }
}

export interface AnalystInput {
  readonly runId: string
  readonly repo: string
  readonly issue: GhIssue
  readonly worktree: string
  readonly conventionFiles: readonly string[]
  readonly config: Config
  /** Cancels the turn when the run it belongs to stops. */
  readonly signal?: AbortSignal
}

/** Plans the change and writes the acceptance criteria. Modifies nothing. */
export async function runAnalyst(
  input: AnalystInput,
): Promise<{ analysis: Analysis; result: StationResult }> {
  const { value, result } = await structuredStation(
    'analyst',
    {
      agent: input.config.agents.analyst,
      runId: input.runId,
      station: 'analyst',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      subject: { repo: input.repo, kind: 'issue', number: input.issue.number },
      title: input.issue.title,
      label: 'analyst',
      worktree: input.worktree,
      systemRules: buildStationRules('analyst'),
      task: buildAnalystPrompt({
        repo: input.repo,
        issue: input.issue,
        conventionFiles: input.conventionFiles,
        tools: toolSurfaceIsUp(),
      }),
      // Reads only. The planning station cannot modify the repository it is
      // planning against, which is a property of the run rather than a promise.
      permission: 'approve-reads',
      config: input.config,
    },
    analysisSchema,
    (result) => result.recorded.analysis,
  )
  return { analysis: value, result }
}

export interface ImplementerInput {
  readonly runId: string
  readonly repo: string
  readonly issue: GhIssue
  readonly worktree: string
  readonly analysis: Analysis
  readonly conventionFiles: readonly string[]
  readonly revision?: { readonly review: Review; readonly attempt: number }
  readonly config: Config
  /** Cancels the turn when the run it belongs to stops. */
  readonly signal?: AbortSignal
}

/** Writes the code against the plan. The only station that may modify files. */
export async function runImplementer(
  input: ImplementerInput,
): Promise<StationResult> {
  return runStation({
    agent: input.config.agents.implementer,
    runId: input.runId,
    station: 'implementer',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    subject: { repo: input.repo, kind: 'issue', number: input.issue.number },
    title: input.issue.title,
    label: 'implementer',
    worktree: input.worktree,
    systemRules: buildStationRules('implementer'),
    task: buildImplementerPrompt({
      repo: input.repo,
      issue: input.issue,
      analysis: input.analysis,
      conventionFiles: input.conventionFiles,
      revision: input.revision,
    }),
    permission: 'approve-all',
    config: input.config,
  })
}

export interface ReviewerInput {
  readonly runId: string
  readonly repo: string
  readonly issue: GhIssue
  /** An independent checkout of the branch, not the implementer's worktree. */
  readonly worktree: string
  readonly analysis: Analysis
  readonly base: string
  readonly branch: string
  readonly config: Config
  /** Cancels the turn when the run it belongs to stops. */
  readonly signal?: AbortSignal
}

/** Judges the real diff against the criteria. Modifies nothing. */
export async function runReviewer(
  input: ReviewerInput,
): Promise<{ review: Review; result: StationResult }> {
  const { value, result } = await structuredStation(
    'reviewer',
    {
      agent: input.config.agents.reviewer,
      runId: input.runId,
      station: 'reviewer',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      subject: { repo: input.repo, kind: 'issue', number: input.issue.number },
      title: input.issue.title,
      label: 'reviewer',
      worktree: input.worktree,
      systemRules: buildStationRules('reviewer'),
      task: buildReviewerPrompt({
        repo: input.repo,
        issue: input.issue,
        analysis: input.analysis,
        base: input.base,
        branch: input.branch,
        tools: toolSurfaceIsUp(),
      }),
      permission: 'approve-reads',
      config: input.config,
    },
    reviewSchema,
    (result) => result.recorded.review,
  )
  return { review: value, result }
}

export interface AnalystReplyInput {
  readonly runId: string
  readonly repo: string
  readonly issueNumber: number
  readonly worktree: string
  readonly question: string
  readonly history: readonly { author: string; role: string; body: string }[]
  readonly config: Config
  readonly signal?: AbortSignal
}

export interface AnalystReplyOutcome {
  /** Present only when the exchange changed the plan. */
  readonly analysis?: Analysis
  readonly result: StationResult
}

/**
 * The analyst answers a maintainer without leaving the gate.
 *
 * Runs as the analyst so it resumes that station's persistent session and still
 * has the plan it wrote in context. The turn has no structured output to
 * validate: what it did is what it recorded, so a revision is detected from the
 * tool call rather than parsed out of prose. A turn that only talks is a
 * complete, correct turn.
 */
export async function runAnalystReply(
  input: AnalystReplyInput,
): Promise<AnalystReplyOutcome> {
  const result = await runStation({
    agent: input.config.agents.analyst,
    runId: input.runId,
    station: 'analyst',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    subject: {
      repo: input.repo,
      kind: 'issue',
      number: input.issueNumber,
    },
    title: `reply at the plan gate for #${input.issueNumber}`,
    label: 'analyst',
    worktree: input.worktree,
    systemRules: buildStationRules('analyst'),
    task: buildReplyPrompt({
      repo: input.repo,
      issueNumber: input.issueNumber,
      question: input.question,
      history: input.history,
      tools: toolSurfaceIsUp(),
    }),
    // Still reads only. The gate is open, so nothing has been approved and the
    // planning station has no business touching the repository.
    permission: 'approve-reads',
    config: input.config,
  })
  return {
    ...(result.recorded.analysis === undefined
      ? {}
      : { analysis: result.recorded.analysis }),
    result,
  }
}

export interface ClassifierInput {
  readonly runId: string
  readonly repo: string
  readonly issue: GhIssue
  readonly worktree: string
  readonly config: Config
  readonly signal?: AbortSignal
}

/** Decides what an issue is, before any code is considered. Modifies nothing. */
// TEMPORARY: consumed by the triage machine, which lands next. Removed there.
// fallow-ignore-next-line unused-export
export async function runClassifier(
  input: ClassifierInput,
): Promise<{ triage: Triage; result: StationResult }> {
  const { value, result } = await structuredStation(
    'classifier',
    {
      agent: input.config.agents.analyst,
      runId: input.runId,
      station: 'classifier',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      subject: { repo: input.repo, kind: 'issue', number: input.issue.number },
      title: input.issue.title,
      label: 'classifier',
      worktree: input.worktree,
      systemRules: buildStationRules('classifier'),
      task: buildTriagePrompt({
        repo: input.repo,
        issue: input.issue,
        tools: toolSurfaceIsUp(),
      }),
      // Reads only. Triage decides whether work should happen; it is not work.
      permission: 'approve-reads',
      config: input.config,
    },
    triageSchema,
    (result) => result.recorded.triage,
  )
  return { triage: value, result }
}
