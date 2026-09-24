import type { Config } from '@/config'
import type { GhIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import { parseStationOutput } from '@/lib/structured'
import {
  buildAnalystPrompt,
  buildImplementerPrompt,
  buildReviewerPrompt,
  buildStationRules,
} from '@/prompts/stations'
import { runStation, type StationResult } from '@/run/station'
import {
  type Analysis,
  analysisSchema,
  type Review,
  reviewSchema,
} from '@/run/stations/schemas'

const log = logger('stations')

export class StationOutputError extends Error {
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
async function structuredStation<T>(
  station: string,
  input: Parameters<typeof runStation>[0],
  schema: Parameters<typeof parseStationOutput<T>>[1],
): Promise<{ value: T; result: StationResult }> {
  let result = await runStation(input)
  let parsed = parseStationOutput(result.text, schema)
  if (!parsed.ok) {
    log.warn(`${station} output did not validate, retrying once`, {
      error: parsed.error,
    })
    result = await runStation({
      ...input,
      task: `${input.task}\n\nYour previous reply could not be used: ${parsed.error}. Reply again with the same content, ending in one valid fenced JSON block matching the fields exactly.`,
    })
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
      label: 'analyst',
      worktree: input.worktree,
      systemRules: buildStationRules('analyst'),
      task: buildAnalystPrompt({
        repo: input.repo,
        issue: input.issue,
        conventionFiles: input.conventionFiles,
      }),
      // Reads only. The planning station cannot modify the repository it is
      // planning against, which is a property of the run rather than a promise.
      permission: 'approve-reads',
      config: input.config,
    },
    analysisSchema,
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
}

/** Writes the code against the plan. The only station that may modify files. */
export async function runImplementer(
  input: ImplementerInput,
): Promise<StationResult> {
  return runStation({
    agent: input.config.agents.implementer,
    runId: input.runId,
    station: 'implementer',
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
      label: 'reviewer',
      worktree: input.worktree,
      systemRules: buildStationRules('reviewer'),
      task: buildReviewerPrompt({
        repo: input.repo,
        issue: input.issue,
        analysis: input.analysis,
        base: input.base,
        branch: input.branch,
      }),
      permission: 'approve-reads',
      config: input.config,
    },
    reviewSchema,
  )
  return { review: value, result }
}
