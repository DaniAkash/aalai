/**
 * The interface in a browser, with the factory behind a token.
 *
 * The desktop shell mints a token per launch and hands it to the sidecar it
 * spawned. Nothing does that for the web mode, so this does: one value, given
 * to the factory on its command line and to the Vite proxy in its environment.
 *
 * It matters because the factory can add watched repositories, change settings
 * and answer gates. An unauthenticated port on a shared machine is reachable by
 * every process on it, which is a real hole rather than a theoretical one.
 *
 * The browser never sees the token. Vite's proxy runs in node and attaches it
 * on the way out, which is the same shape as the desktop build, where the
 * secret lives in Rust and not in the webview.
 */

import { join } from 'node:path'
import { bad, heading, note, ok } from '../packages/core/src/lib/output'

const root = join(import.meta.dir, '..')
const target = process.env.AALAI_API_URL ?? 'http://127.0.0.1:4173'

// An explicit token wins, so this can point at a factory somebody else started.
const token = process.env.AALAI_API_TOKEN ?? crypto.randomUUID()
const started = process.env.AALAI_API_TOKEN === undefined

heading('aalai on the web')
note(
  'factory',
  started ? 'starting behind a fresh token' : 'using AALAI_API_TOKEN',
)
note('interface', 'http://localhost:5173')

const children = [
  started
    ? Bun.spawn(['bun', 'run', 'src/index.ts', '--token', token], {
        cwd: join(root, 'packages', 'core'),
        stdout: 'inherit',
        stderr: 'inherit',
      })
    : undefined,
  Bun.spawn(['bun', 'run', 'dev:web'], {
    cwd: join(root, 'app', 'native'),
    env: { ...process.env, AALAI_API_TOKEN: token },
    stdout: 'inherit',
    stderr: 'inherit',
  }),
].filter((child) => child !== undefined)

/**
 * Waits for a factory that accepts our token, and gives up loudly otherwise.
 *
 * Authenticated on purpose. A port already in use does not stop the factory:
 * it logs a warning and runs on without an API, so the port stays answered by
 * whoever had it first. `/api/health` needs no token and would cheerfully
 * confirm that stranger, leaving every real call to 401 behind a page that
 * looks merely empty. Asking a route that checks the token is what tells our
 * factory apart from somebody else's.
 */
async function waitForFactory(): Promise<void> {
  const deadline = Date.now() + 15_000
  let sawStranger = false
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${target}/api/gates`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1000),
      })
      if (response.ok) {
        ok('factory answering', target)
        return
      }
      sawStranger = response.status === 401
    } catch {
      // Not up yet. A fresh install migrates on first start, which takes a
      // moment, so this is the ordinary case rather than a problem.
    }
    await Bun.sleep(250)
  }
  bad(
    sawStranger
      ? 'another factory already holds that port'
      : 'the factory never answered',
    target,
  )
  note('check with', `lsof -nP -iTCP:${new URL(target).port} -sTCP:LISTEN`)
  note('or point elsewhere', 'AALAI_API_URL, with AALAI_API_TOKEN to match')
  stop()
  process.exit(1)
}

function stop(): void {
  for (const child of children) {
    child.kill()
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stop()
    process.exit(0)
  })
}

await waitForFactory()

// Either one exiting takes the other with it: a page with no factory behind it
// is a page that renders errors, and a factory with no page is a background
// process somebody has to remember to kill.
await Promise.race(children.map((child) => child.exited))
stop()
