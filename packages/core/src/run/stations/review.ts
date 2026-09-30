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
   * An empty directory with no git repository in it.
   *
   * Not a checkout of anything, and specifically not a worktree of our clone of
   * the repository under review, which is what this said first and was wrong
   * about: a worktree shares its clone's objects and refs, so
   * `git show origin/their-branch:file` prints the contributor's code from
   * inside one, and the agent reading has a shell no permission mode gates.
   *
   * Where this points is the only thing keeping a stranger's code from being
   * executable here, so it is worth being exact about in the one place a future
   * caller will read.
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
