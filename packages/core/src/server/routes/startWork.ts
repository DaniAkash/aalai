import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { loadConfig } from '@/config'
import { createIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import { claimQueuedSubject, enqueueRun, offerRun } from '@/modules/runs/queue'
import { RUN_POLICIES } from '@/modules/settings/domains'
import { titleFromBrief } from '@/shared/brief'
import { workId } from '@/shared/workView'
import { startQueued } from '@/watch/startRun'
import { openState } from '@/watch/state'

const log = logger('work')

/**
 * Starting a piece of work from a description rather than from an issue.
 *
 * The brief becomes a real GitHub issue before anything else happens. Every
 * other surface hangs off a subject: the thread, the gates, the artifacts, the
 * pull request that will close it. Work that existed only here would be a
 * second kind none of those could reference, and nobody but this machine could
 * see it.
 *
 * The issue is opened first and the row second, so a failure to reach GitHub
 * leaves nothing behind. The reverse order would leave a queued run pointing at
 * an issue number that does not exist.
 */

const startSchema = z.object({
  repo: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/),
  brief: z.string().trim().min(1).max(20_000),
  mode: z.enum(RUN_POLICIES),
})

export const startWorkRoute = new Hono().post(
  '/work',
  zValidator('json', startSchema),
  async (c) => {
    const { repo, brief, mode } = c.req.valid('json')
    const config = await loadConfig()
    if (!config.watch.some((watched) => watched.repo === repo)) {
      // Not a permission check: a run needs the repository's settings and a
      // clone, and neither exists for one that was never added.
      return c.json({ error: `${repo} is not one of your repositories` }, 400)
    }

    let issue: Awaited<ReturnType<typeof createIssue>>
    try {
      issue = await createIssue(repo, titleFromBrief(brief), brief)
    } catch (error) {
      log.error('could not open the issue', { repo, error })
      return c.json(
        { error: `could not open an issue on ${repo}`, cause: String(error) },
        502,
      )
    }

    const db = openState()
    try {
      offerRun(db, {
        repo,
        kind: 'issue',
        number: issue.number,
        title: issue.title,
        policy: mode,
      })
      enqueueRun(db, repo, 'issue', issue.number)
      // A paused queue stops this starting, not just the scheduler promoting.
      // `claimQueuedSubject` only bounds the running count, so without this a
      // brief sent while paused would start immediately while the composer was
      // saying nothing starts until you resume.
      const claimed = config.queuePaused
        ? undefined
        : // Through the same capacity bounded statement the scheduler uses, so
          // a Start press and a poll cannot both believe they have the last
          // slot.
          claimQueuedSubject(
            db,
            repo,
            'issue',
            issue.number,
            config.maxParallelRuns,
          )
      const entry = claimed?.entry
      if (claimed !== undefined && entry !== undefined) {
        // Detached, and it opens its own connection, so closing this one
        // cannot pull the floor out from under it.
        void startQueued(config, entry, claimed.lease)
      }
      return c.json(
        {
          id: workId({ repo, kind: 'issue', number: issue.number }),
          repo,
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          // What actually happened, rather than what was asked for. A composer
          // that says "starting now" when the queue is full is the same lie as
          // a progress bar that does not move.
          started: claimed !== undefined,
        },
        201,
      )
    } finally {
      db.close()
    }
  },
)
