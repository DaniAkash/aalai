import { doctor, showStatus } from '@/commands'
import { type Config, loadConfig } from '@/config'
import { answerGateCommand, showGate, showGates } from '@/gateCommands'
import { captureInheritedTokens } from '@/lib/credentials'
import { serverDisabled } from '@/lib/env'
import { getIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import { exitWithParent } from '@/lib/parent'
import { runIssue } from '@/run/pipeline'
import { announceReady, startServer, stopServer } from '@/server/serve'
import { screenIssue } from '@/watch/intake'
import { pollOnce } from '@/watch/poll'
import { claimRun, completeRun, forgetRun, openState } from '@/watch/state'

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

/** Starts the API and, when a shell is listening, tells it where to connect. */
function startApi(config: Config): void {
  // Spawned by the desktop shell rather than run by hand.
  if (flag('port') !== undefined) exitWithParent()

  const requested = flag('port')
  const handle = startServer(
    requested === undefined ? config.uiPort : Number(requested),
    flag('token'),
  )
  if (handle) announceReady(handle)
}

async function serve(config: Config): Promise<void> {
  const db = openState()
  const controller = new AbortController()

  startApi(config)

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

  while (!controller.signal.aborted) {
    try {
      const handled = await pollOnce(db, config)
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
    await sleep(config.pollSeconds * 1000, controller.signal)
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
    const handled = await pollOnce(db, config)
    log.info('single pass complete', { handled })
    db.close()
  })
}

/** Manual trigger. Bypasses the cursor but still claims, so a demo cannot double-run. */
async function runOne(
  config: Config,
  repo: string,
  issueNumber: number,
): Promise<void> {
  const db = openState()
  if (!serverDisabled()) {
    startApi(config)
  }
  const issue = await getIssue(repo, issueNumber)
  const screening = screenIssue(issue, {
    trustedAuthorsOnly: config.trustedAuthorsOnly,
    requireLabel: config.requireLabel,
  })
  if (!screening.accepted) {
    log.error('issue rejected by intake policy', { reason: screening.reason })
    process.exitCode = 1
    db.close()
    return
  }
  const lease = claimRun(
    db,
    repo,
    issueNumber,
    config.staleClaimMinutes * 60_000,
  )
  if (lease === null) {
    log.error('already run; use `aalai forget <repo> <issue>` to retry', {
      repo,
      issue: issueNumber,
    })
    process.exitCode = 1
    db.close()
    return
  }
  const result = await runIssue(repo, issue, config)
  completeRun(db, repo, issueNumber, {
    status: result.status,
    branch: result.branch,
    prUrl: result.prUrl,
    error: result.error,
    lease,
  })
  log.info('done', {
    status: result.status,
    pr: result.prUrl,
    error: result.error,
  })
  if (result.status === 'failed') {
    process.exitCode = 1
  }
  db.close()
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
  await runOne(config, parsed.repo, parsed.issueNumber)
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
  // Answering needs no factory running and no window open, which is the
  // property that makes a gate a property of the run rather than of an app.
  if (command === 'gates') {
    showGates(rest)
    return
  }
  if (command === 'show') {
    await showGate(rest)
    return
  }
  if (command === 'approve') {
    await answerGateCommand('approved', rest)
    return
  }
  if (command === 'reject') {
    await answerGateCommand('rejected', rest)
    return
  }
  if (command === 'changes') {
    await answerGateCommand('changes', rest)
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
