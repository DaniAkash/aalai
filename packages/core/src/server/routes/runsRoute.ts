import { Hono } from 'hono'
import { activeRuns, latestRunId, replay } from '@/events/bus'
import { listRuns, openState } from '@/watch/state'

/**
 * Run state, read straight from the two places it already lives: the event
 * buffer for runs in flight, and sqlite for the history.
 */
export const runsRoute = new Hono()
  .get('/runs', (c) => {
    const db = openState()
    try {
      return c.json({ runs: listRuns(db, 20) })
    } finally {
      db.close()
    }
  })
  .get('/live', (c) =>
    c.json({
      latest: latestRunId(),
      runs: activeRuns().map((run) => ({ runId: run.runId, events: run.events.length })),
    }),
  )
  .get('/live/:runId', (c) => {
    const runId = decodeURIComponent(c.req.param('runId'))
    return c.json({ runId, events: replay(runId) })
  })
