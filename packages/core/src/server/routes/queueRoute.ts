import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { loadConfig, saveConfig } from '@/config'
import { RUN_STATUSES, SUBJECT_KINDS } from '@/modules/db/schema/schema'
import {
  dismissRun,
  enqueueRun,
  listQueue,
  readRun,
  runningCount,
} from '@/watch/queue'
import { promoteQueued } from '@/watch/scheduler'
import { startQueued } from '@/watch/startRun'
import { openState } from '@/watch/state'

const subjectParam = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(SUBJECT_KINDS),
  number: z.coerce.number().int().min(1),
})

const listQuery = z.object({ status: z.enum(RUN_STATUSES).optional() })

/**
 * The queue, and the only way work begins.
 *
 * Every route here is a person acting. Nothing in this file is reachable from
 * a poll, which is the property that keeps a laptop usable: discovery may only
 * record that something exists.
 */
export const queueRoute = new Hono()
  .get('/queue', zValidator('query', listQuery), async (c) => {
    const { status } = c.req.valid('query')
    const config = await loadConfig()
    const db = openState()
    try {
      return c.json({
        entries: listQuery.shape.status.isOptional()
          ? listQueue(db, status)
          : [],
        running: runningCount(db),
        capacity: config.maxParallelRuns,
        paused: config.queuePaused,
      })
    } finally {
      db.close()
    }
  })
  .post(
    '/queue/:owner/:name/:kind/:number',
    zValidator('param', subjectParam),
    (c) =>
      act(
        c.req.valid('param'),
        enqueueRun,
        'cannot be queued from its current state',
      ),
  )
  .delete(
    '/queue/:owner/:name/:kind/:number',
    zValidator('param', subjectParam),
    (c) =>
      act(
        c.req.valid('param'),
        dismissRun,
        'only an offer or a queued run can be dismissed',
      ),
  )
  .post(
    '/queue/:owner/:name/:kind/:number/start',
    zValidator('param', subjectParam),
    async (c) => {
      const { owner, name, kind, number } = c.req.valid('param')
      const repo = `${owner}/${name}`
      const config = await loadConfig()
      const db = openState()
      try {
        // Refused rather than silently queued behind everything else. A Start
        // button that quietly means "eventually" is a broken button.
        if (runningCount(db) >= config.maxParallelRuns) {
          return c.json(
            {
              error: `no free slot, ${config.maxParallelRuns} already running`,
            },
            409,
          )
        }
        if (!enqueueRun(db, repo, kind, number)) {
          const current = readRun(db, repo, kind, number)
          if (current?.status !== 'queued') {
            return c.json(
              { error: 'cannot be started from its current state' },
              409,
            )
          }
        }
        const entry = readRun(db, repo, kind, number)
        if (entry === undefined) {
          return c.json({ error: 'not found' }, 404)
        }
        // Started, not awaited: a run takes minutes and the request should not.
        void startQueued(db, config, entry)
        return c.json({ entry })
      } finally {
        db.close()
      }
    },
  )
  .post(
    '/queue/pause',
    zValidator('json', z.object({ paused: z.boolean() })),
    async (c) => {
      const { paused } = c.req.valid('json')
      const config = await loadConfig()
      await saveConfig({ ...config, queuePaused: paused })
      const db = openState()
      try {
        if (!paused) {
          const next = await loadConfig()
          void promoteQueued(db, next, (entry) => startQueued(db, next, entry))
        }
        return c.json({ paused })
      } finally {
        db.close()
      }
    },
  )

type Subject = z.infer<typeof subjectParam>

/**
 * Queueing and dismissing differ only in which function they call and what
 * they say when it refuses, so the connection handling lives once.
 */
function act(
  subject: Subject,
  change: (
    db: ReturnType<typeof openState>,
    repo: string,
    kind: Subject['kind'],
    number: number,
  ) => boolean,
  refusal: string,
): Response {
  const repo = `${subject.owner}/${subject.name}`
  const db = openState()
  try {
    if (!change(db, repo, subject.kind, subject.number)) {
      return Response.json({ error: refusal }, { status: 409 })
    }
    return Response.json({
      entry: readRun(db, repo, subject.kind, subject.number),
    })
  } finally {
    db.close()
  }
}
