import type { Config } from '@/config'
import { buildStaticReviewPrompt, buildStationRules } from '@/prompts/stations'
import { runStation, type StationResult } from '@/run/station'

export interface StaticReviewInput {
  readonly runId: string
  readonly repo: string
  readonly prNumber: number
  readonly title: string
  readonly diff: string
  readonly authors: readonly string[]
  readonly willRun: boolean
  /**
   * A checkout of our own default branch, never the contributor's.
   *
   * The station needs somewhere to run, and where that is matters more than
   * anything the permission mode says: an agent can run shell commands whatever
   * mode it is in, so the only thing keeping a stranger's code from executing is
   * that it is not on disk here.
   */
  readonly worktree: string
  readonly config: Config
  readonly signal?: AbortSignal
}

/** Reads somebody else's change and says what it thinks, having run nothing. */
export async function runStaticReview(
  input: StaticReviewInput,
): Promise<StationResult> {
  return runStation({
    agent: input.config.agents.reviewer,
    runId: input.runId,
    station: 'reviewer',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    subject: { repo: input.repo, kind: 'pr', number: input.prNumber },
    title: input.title,
    label: 'static-review',
    worktree: input.worktree,
    systemRules: buildStationRules('reviewer'),
    task: buildStaticReviewPrompt({
      repo: input.repo,
      prNumber: input.prNumber,
      title: input.title,
      diff: input.diff,
      authors: input.authors,
      willRun: input.willRun,
    }),
    // Worth setting and worth nothing as a guarantee, which is why the
    // contributor's code is not here to be run.
    permission: 'approve-reads',
    config: input.config,
  })
}
