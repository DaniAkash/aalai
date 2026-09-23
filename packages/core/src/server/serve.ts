import { logger } from '@/lib/log'
import { app } from '@/server/app'

const log = logger('server')

export interface ServerHandle {
  readonly port: number
  readonly token: string | null
}

/**
 * Serves the API only. The desktop app ships its own interface and talks to
 * this over HTTP, so nothing static is served here any more.
 *
 * Port 0 asks the OS for a free port and the caller reads the real one back.
 * A desktop app must not squat a fixed port, and choosing one up front races:
 * another process can take it between the check and the bind.
 *
 * The token, when set, is required by every route except health. This server
 * can open pull requests and any local process can reach 127.0.0.1, so an
 * unauthenticated localhost port is a real hole rather than a theoretical one.
 */
export function startServer(port: number, token?: string): ServerHandle | null {
  try {
    const server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      fetch: (request) => {
        const url = new URL(request.url)
        if (!url.pathname.startsWith('/api')) {
          return new Response('aalai api\n', { status: 404 })
        }
        if (token && url.pathname !== '/api/health' && !authorised(request, token)) {
          return new Response('unauthorised\n', { status: 401 })
        }
        return app.fetch(request)
      },
    })

    // Bun types the port as optional because a unix socket server has none.
    // This one always binds TCP, so an absent port is a broken assumption
    // rather than a case to handle quietly.
    const bound = server.port
    if (bound === undefined) throw new Error('server bound without a port')

    log.info('api ready', { url: `http://127.0.0.1:${bound}` })
    return { port: bound, token: token ?? null }
  } catch (error) {
    // The API is an observer. A port problem must not take the factory down
    // with it: the run is the product and the screen is a convenience.
    log.warn('api not started, continuing without it', {
      port,
      error: error instanceof Error ? error.message : error,
    })
    return null
  }
}

function authorised(request: Request, token: string): boolean {
  const header = request.headers.get('authorization')
  return header === `Bearer ${token}`
}

/**
 * The line the desktop shell parses on stdout to learn where to connect.
 *
 * Written rather than logged so it is a contract instead of a log format that
 * someone later makes prettier.
 */
export function announceReady(handle: ServerHandle): void {
  process.stdout.write(
    `${JSON.stringify({ ready: true, port: handle.port, pid: process.pid })}\n`,
  )
}
