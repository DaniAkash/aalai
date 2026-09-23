import { Hono } from 'hono'
import { eventsRoute } from '@/server/routes/eventsRoute'
import { runsRoute } from '@/server/routes/runsRoute'

/**
 * The service's own HTTP surface.
 *
 * Mounted in the same process that runs the pipeline, so the dashboard is one
 * command and one port. A demo that needs two terminals is a demo with two
 * more ways to fail.
 */
export const app = new Hono()
  .get('/api/health', (c) => c.json({ ok: true }))
  .route('/api', runsRoute)
  .route('/api', eventsRoute)

/** The contract the UI's typed client is generated from. */
export type AppType = typeof app
