import { fromCallback, fromPromise } from 'xstate'
import { getIssue } from '@/lib/gh'
import { headSha } from '@/lib/git'
import { redactDeep } from '@/lib/redact'
import { latestArtifact } from '@/modules/work/artifacts'
import { readJson } from '@/modules/work/store'
import { recordAnalysis, recordBestEffort, recordReview } from '@/run/artifacts'
import type { CommitOutcome } from '@/run/commit'
import { commitImplementerWork } from '@/run/commit'
import { runAnalyst, runImplementer, runReviewer } from '@/run/stations'
import type { Analysis, Review } from '@/run/stations/schemas'
import { prepareReviewWorkspace } from '@/run/workspace'
import { runDeps } from './deps'
import { runAttempt } from './runner'

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
          await recordBestEffort('analysis', () =>
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
          await recordBestEffort('review', () =>
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

/** How often the premise is re-checked while a run works. */
const PREMISE_INTERVAL_MS = 60_000

/**
 * Watches for the ground moving under a run.
 *
 * Every station has a reason for existing, and that reason can stop being true
 * while it works: the issue gets closed, or its text is rewritten into a
 * different request. Modelling that as a transition out of every station would
 * be unreadable, so it lives in a region of its own that runs for the whole
 * life of the machine and raises into the work region when it finds something.
 *
 * Cheap on purpose. It asks GitHub one question on a timer and holds no state
 * beyond the body it started with.
 */
export const premise = fromCallback<
  { type: string },
  { runId: string; body: string; intervalMs?: number }
>(({ input, sendBack }) => {
  const every = input.intervalMs ?? PREMISE_INTERVAL_MS
  let checking = false

  const check = async (): Promise<void> => {
    if (checking) {
      return
    }
    checking = true
    try {
      const deps = runDeps(input.runId)
      const issue = await getIssue(deps.repo, deps.issue.number)
      if (issue.state !== 'open') {
        sendBack({
          type: 'PREMISE_ABORT',
          reason: `the issue was ${issue.state} while the run was working`,
        })
        return
      }
      if ((issue.body ?? '') !== input.body) {
        sendBack({
          type: 'PREMISE_REPLAN',
          reason: 'the issue was rewritten while the run was working',
        })
      }
    } catch {
      // A failed check is not a failed premise. GitHub being briefly
      // unreachable must not abort work that is otherwise fine.
    } finally {
      checking = false
    }
  }

  const timer = setInterval(() => void check(), every)
  return () => clearInterval(timer)
})
