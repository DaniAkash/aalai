import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '@/lib/log'
import { app } from '@/server/app'

const log = logger('server')

/** Where `bun run ui:build` leaves the dashboard. */
const UI_DIST = join(import.meta.dir, '..', '..', 'ui', 'dist')

/**
 * Serves the API and, when it has been built, the dashboard itself.
 *
 * The built UI is served from this process rather than from a dev server, so
 * there is one thing to start and nothing to remember. A missing build is not
 * an error: the service runs perfectly well without a dashboard, which is what
 * keeps the terminal path the dependable one.
 */
export function startServer(port: number): void {
  const hasUi = existsSync(join(UI_DIST, 'index.html'))

  Bun.serve({
    port,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)

      if (url.pathname.startsWith('/api')) {
        return app.fetch(request)
      }
      if (!hasUi) {
        return new Response('The dashboard has not been built. Run: bun run ui:build\n', {
          status: 404,
        })
      }

      const file = Bun.file(join(UI_DIST, url.pathname === '/' ? 'index.html' : url.pathname))
      if (await file.exists()) {
        return new Response(file)
      }
      // Single page app: unknown paths fall back to the document.
      return new Response(Bun.file(join(UI_DIST, 'index.html')))
    },
  })

  log.info(hasUi ? 'dashboard ready' : 'api ready, dashboard not built', {
    url: `http://localhost:${port}`,
  })
}
