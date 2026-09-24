import type { Config } from '@/config'
import type { GhIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import { parseStationOutput } from '@/lib/structured'
import { toolSurfaceIsUp } from '@/modules/tools/endpoint'
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
}

/** Writes the code against the plan. The only station that may modify files. */
export async function runImplementer(
  input: ImplementerInput,
): Promise<StationResult> {
  return runStation({
    agent: input.config.agents.implementer,
    runId: input.runId,
    station: 'implementer',
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
