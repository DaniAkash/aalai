import { doctor, showStatus } from '@/commands'
import { type Config, loadConfig } from '@/config'
import { answerGateCommand, showGate, showGates } from '@/gateCommands'
import { captureInheritedTokens } from '@/lib/credentials'
import { serverDisabled } from '@/lib/env'
import { logger } from '@/lib/log'
import { runOne } from '@/runCommand'
import { startApi, startServer, stopServer } from '@/server/serve'
import { replyCommand, showThread } from '@/threadCommands'
import { pollOnce } from '@/watch/poll'
import { forgetRun, openState } from '@/watch/state'

const log = logger('aalai')

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * Reads a flag the desktop shell passes when it spawns this process.
 *
 * The shell owns the port and the token so every launch gets a fresh pair.
 * Falling back to the config keeps the terminal path working with no shell
 * present, which is the property this whole layout protects.
 */
function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

async function serve(config: Config): Promise<void> {
  const db = openState()
  const controller = new AbortController()

  startApi({
    defaultPort: config.uiPort,
    port: flag('port'),
    token: flag('token'),
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info(`${signal} received, finishing the current tick`)
      controller.abort()
    })
  }

  log.info('aalai is watching', {
    repos: config.watch.map((w) => w.repo).join(','),
    every: `${config.pollSeconds}s`,
    agents: Object.values(config.agents).join(','),
    trustedOnly: config.trustedAuthorsOnly,
  })

  let watching = config.watch.map((w) => w.repo).join(',')
  let interval = config.pollSeconds
  while (!controller.signal.aborted) {
    try {
      // Re-read each tick. Settings and watched repositories are changed while
      // this is running, by the app and by a terminal, and a loop holding the
      // config it started with silently ignores every one of them: a repository
      // added in the interface would do nothing until a restart.
      const current = await loadConfig()
      const repos = current.watch.map((w) => w.repo).join(',')
      if (repos !== watching) {
        watching = repos
        log.info('watching changed', { repos: repos || 'nothing' })
      }
      interval = current.pollSeconds
      const handled = await pollOnce(db, current)
      if (handled > 0) {
        log.info('tick complete', { handled })
      }
    } catch (error) {
      log.error('tick failed', {
        error: error instanceof Error ? error.message : error,
      })
    }
    if (controller.signal.aborted) {
      break
    }
    // The freshly read one, or changing the interval in the interface would
    // wait out the old one before it ever took effect.
    await sleep(interval * 1000, controller.signal)
  }

  db.close()
  log.info('stopped')
}

/**
 * The api, for a command that runs once and exits.
 *
 * Not announced and not on a fixed port: nothing is waiting for a handshake
 * here. It exists so a headless pass records through the same tools a served
 * run does, rather than quietly falling back to parsed prose.
 */
function withToolSurface<T>(work: () => Promise<T>): Promise<T> {
  if (serverDisabled()) {
    return work()
  }
  startServer(0, crypto.randomUUID())
  return work().finally(stopServer)
}

async function once(config: Config): Promise<void> {
  await withToolSurface(async () => {
    const db = openState()
    // Waits for what it started, because a one shot pass that returns while
    // its runs are still going is a pass that reports a number and then kills
    // the work behind it.
    const handled = await pollOnce(db, config, { awaitStarted: true })
    log.info('single pass complete', { handled })
    db.close()
  })
}

function parseRepoIssue(
  args: readonly string[],
  usage: string,
): { repo: string; issueNumber: number } | null {
  const [repo, issueArg] = args
  const issueNumber = Number(issueArg)
  if (
    repo === undefined ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber <= 0
  ) {
    log.error(usage)
    process.exitCode = 1
    return null
  }
  return { repo, issueNumber }
}

function forget(args: readonly string[]): void {
  const parsed = parseRepoIssue(
    args,
    'usage: aalai forget <owner/repo> <issue-number>',
  )
  if (parsed === null) {
    return
  }
  const db = openState()
  log.info(
    forgetRun(db, parsed.repo, parsed.issueNumber)
      ? 'forgotten'
      : 'no record found',
    { repo: parsed.repo, issue: parsed.issueNumber },
  )
  db.close()
}

async function run(config: Config, args: readonly string[]): Promise<void> {
  const parsed = parseRepoIssue(
    args,
    'usage: aalai run <owner/repo> <issue-number>',
  )
  if (parsed === null) {
    return
  }
  await runOne(config, parsed.repo, parsed.issueNumber, {
    port: flag('port'),
    token: flag('token'),
  })
}

function holdInheritedTokens(): void {
  // Tokens move out of the ambient environment so the agent cannot inherit
  // them, and are handed back explicitly to aalai's own gh and git commands.
  const captured = captureInheritedTokens()
  if (captured.length > 0) {
    log.debug('holding GitHub tokens outside the ambient environment', {
      vars: captured.join(','),
    })
  }
}

/** The gate surface, answerable with nothing else running. */
const GATE_COMMANDS: Record<
  string,
  (args: readonly string[]) => void | Promise<void>
> = {
  gates: showGates,
  show: showGate,
  thread: showThread,
  reply: replyCommand,
  approve: (args) => answerGateCommand('approved', args),
  reject: (args) => answerGateCommand('rejected', args),
  changes: (args) => answerGateCommand('changes', args),
  reclassify: (args) => answerGateCommand('reclassify', args),
}

async function main(): Promise<void> {
  holdInheritedTokens()

  const [command, ...rest] = process.argv.slice(2)

  if (command === 'forget') {
    forget(rest)
    return
  }
  if (command === 'status') {
    showStatus()
    return
  }
  if (command === 'doctor') {
    await doctor()
    return
  }
  // None of these need a factory running or a window open, which is the
  // property that makes a gate belong to the run rather than to an app.
  // Own keys only. A plain object inherits `toString`, `constructor` and the
  // rest, so `aalai toString` would have called Object.prototype.toString with
  // the CLI's arguments and `aalai __proto__` would have thrown, instead of
  // either falling through to the usage text.
  const gateCommand =
    command !== undefined && Object.hasOwn(GATE_COMMANDS, command)
      ? GATE_COMMANDS[command]
      : undefined
  if (gateCommand !== undefined) {
    await gateCommand(rest)
    return
  }

  const config = await loadConfig()

  if (command === 'run') {
    await run(config, rest)
    return
  }
  if (command === '--once' || command === 'once') {
    await once(config)
    return
  }
  await serve(config)
}

await main()
