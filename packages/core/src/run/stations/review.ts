import type { Config } from '@/config'
import {
  buildReviewAnswerPrompt,
  buildStaticReviewPrompt,
  buildStationRules,
} from '@/prompts/stations'
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

export interface ReviewAnswerInput {
  readonly runId: string
  readonly repo: string
  readonly prNumber: number
  /** The issue this pull request is for, which owns the thread. */
  readonly issueNumber: number
  readonly title: string
  readonly comments: readonly {
    readonly id: number
    readonly author: string
    readonly body: string
    readonly path: string | null
    readonly line: number | null
  }[]
  readonly worktree: string
  readonly config: Config
  readonly signal?: AbortSignal
}

/**
 * Answers a review of our own pull request, and may change the code to do it.
 *
 * The subject is the issue rather than the pull request, because the thread a
 * person reads is the issue's: the plan, the gates and the implementation are
 * all there, and the review is the next part of that conversation rather than
 * a separate one. The comments were recorded against the issue too, so an
 * answer filed anywhere else would never meet the comment it answers.
 */
export async function runReviewAnswerer(
  input: ReviewAnswerInput,
): Promise<StationResult> {
  return runStation({
    agent: input.config.agents.reviewer,
    runId: input.runId,
    station: 'reviewer',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    subject: { repo: input.repo, kind: 'issue', number: input.issueNumber },
    title: input.title,
    label: 'review-answer',
    worktree: input.worktree,
    systemRules: buildStationRules('reviewer'),
    task: buildReviewAnswerPrompt({
      repo: input.repo,
      prNumber: input.prNumber,
      comments: input.comments,
    }),
    // It may change the code it was asked about, which is the difference
    // between this and the review that judges a stranger's diff.
    permission: 'approve-all',
    config: input.config,
  })
}
