import { fromPromise } from 'xstate'
import { headSha } from '@/lib/git'
import { logger } from '@/lib/log'
import { redactDeep } from '@/lib/redact'
import { latestArtifact } from '@/modules/work/artifacts'
import { readJson } from '@/modules/work/store'
import { recordAnalysis, recordReview } from '@/run/artifacts'
import type { CommitOutcome } from '@/run/commit'
import { commitImplementerWork } from '@/run/commit'
import { runAnalyst, runImplementer, runReviewer } from '@/run/stations'
import type { Analysis, Review } from '@/run/stations/schemas'
import { prepareReviewWorkspace } from '@/run/workspace'
import { runDeps } from './deps'
import { runAttempt } from './runner'

const log = logger('pipeline')

/**
 * Artifacts are written best effort.
 *
 * A run that produced a pull request has done its job, and a full disk under
 * the work directory is not a reason to throw that away.
 */
async function recordArtifacts(
  what: string,
  write: () => Promise<unknown>,
): Promise<void> {
  try {
    await write()
  } catch (error) {
    log.error('could not write artifacts', {
      what,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export const analyst = fromPromise(
  async ({ input }: { input: { runId: string } }): Promise<Analysis> => {
    const deps = runDeps(input.runId)
    const outcome = await runAttempt<Analysis>({
      db: deps.db,
      run: deps.run,
      runId: input.runId,
      station: 'analyst',
      revision: 0,
      // The plan is on disk under this run, so an attempt that started and
      // never settled can be answered from what it already produced rather
      // than by spending another turn asking for the same plan.
      reconcile: async () => await readJson<Analysis>(deps.run, 'analysis'),
      execute: async () => {
        const { analysis, result } = await runAnalyst({
          runId: input.runId,
          repo: deps.repo,
          issue: deps.issue,
          worktree: deps.workspace.worktreePath,
          conventionFiles: deps.conventionFiles,
          config: deps.config,
        })
        // Only when the station did not record it itself. A tool call already
        // wrote the plan and the criteria, and writing them again would make a
        // second version of each for one run.
        if (result.recorded.analysis === undefined) {
          await recordArtifacts('analysis', () =>
            recordAnalysis(deps.run.subject, deps.run, deps.issue, analysis),
          )
        }
        return analysis
      },
    })
    return outcome.value
  },
)

export const implementer = fromPromise(
  async ({
    input,
  }: {
    input: { runId: string; revision: number; review?: Review }
  }): Promise<{ report: string; commit: CommitOutcome }> => {
    const deps = runDeps(input.runId)
    const outcome = await runAttempt<
      { report: string; commit: CommitOutcome },
      { head: string | undefined }
    >({
      db: deps.db,
      run: deps.run,
      runId: input.runId,
      station: 'implementer',
      revision: input.revision,
      // The branch already differs from the base once any revision has
      // committed, so the aggregate diff cannot say whether *this* revision
      // did anything. The commit it started from can.
      captureBefore: async () => ({
        head: await headSha(deps.workspace.worktreePath),
      }),
      reconcile: async (before) => {
        if (before?.head === undefined) {
          return undefined
        }
        const head = await headSha(deps.workspace.worktreePath)
        return head === undefined || head === before.head
          ? undefined
          : { report: '', commit: 'committed' as const }
      },
      execute: async () => {
        const analysis = await requireAnalysis(input.runId)
        const turn = await runImplementer({
          runId: input.runId,
          repo: deps.repo,
          issue: deps.issue,
          worktree: deps.workspace.worktreePath,
          analysis,
          conventionFiles: deps.conventionFiles,
          ...(input.review === undefined
            ? {}
            : {
                revision: { review: input.review, attempt: input.revision },
              }),
          config: deps.config,
        })
        const commit = await commitImplementerWork(
          input.runId,
          deps.workspace,
          deps.issue,
          input.revision,
          deps.config,
        )
        return { report: turn.text, commit }
      },
    })
    return outcome.value
  },
)

export const reviewer = fromPromise(
  async ({
    input,
  }: {
    input: { runId: string; revision: number }
  }): Promise<{ review: Review; worktree?: string }> => {
    const deps = runDeps(input.runId)
    const outcome = await runAttempt<
      { review: Review; worktree?: string },
      { reviews: number }
    >({
      db: deps.db,
      run: deps.run,
      runId: input.runId,
      station: 'reviewer',
      revision: input.revision,
      // review.json holds the latest verdict for the run, not for this
      // attempt, so a revision that was interrupted would otherwise adopt the
      // previous revision's verdict and judge code it never saw. The versioned
      // artifact is what distinguishes them: only a review written after this
      // attempt began belongs to it.
      //
      // No worktree comes back either: one is only needed to produce a verdict
      // and this attempt already produced one, so rebuilding it would be a
      // checkout made to be deleted.
      captureBefore: async () => ({
        reviews:
          (await latestArtifact(deps.run.subject, 'review'))?.version ?? 0,
      }),
      reconcile: async (before) => {
        if (before === undefined || before === null) {
          return undefined
        }
        const latest = await latestArtifact(deps.run.subject, 'review')
        if (latest === undefined || latest.version <= before.reviews) {
          return undefined
        }
        const recorded = await readJson<Review>(deps.run, 'review')
        return recorded === undefined ? undefined : { review: recorded }
      },
      execute: async () => {
        const analysis = await requireAnalysis(input.runId)
        const worktree = await prepareReviewWorkspace(deps.workspace)
        const { review, result } = await runReviewer({
          runId: input.runId,
          repo: deps.repo,
          issue: deps.issue,
          worktree,
          analysis,
          base: deps.workspace.base,
          branch: deps.workspace.branch,
          config: deps.config,
        })
        // Redacted at the boundary: every field below is published, either in
        // the pull request body or in an issue comment on a stopped run.
        const safe = redactDeep(review, deps.workspace.worktreePath)
        if (result.recorded.review === undefined) {
          await recordArtifacts('review', () =>
            recordReview(deps.run.subject, deps.run, deps.issue, safe),
          )
        }
        return { review: safe, worktree }
      },
    })
    return outcome.value
  },
)

/**
 * The analysis a later station works to.
 *
 * Read from the attempt record rather than passed down, so a station resumed
 * after a restart works to the same plan the first pass produced.
 */
async function requireAnalysis(runId: string): Promise<Analysis> {
  const deps = runDeps(runId)
  const outcome = await runAttempt<Analysis>({
    db: deps.db,
    run: deps.run,
    runId,
    station: 'analyst',
    revision: 0,
    execute: async () => {
      throw new Error('the plan is missing and cannot be recovered')
    },
  })
  return outcome.value
}
