#!/usr/bin/env node

/**
 * The entry `npx aalai` reaches.
 *
 * The factory is written against Bun: it imports `bun:sqlite`, reads files
 * through `Bun.file`, serves with `Bun.serve`, and loads its migrations as
 * text through an import attribute. None of that runs on node, and the
 * published sources are TypeScript besides.
 *
 * So this is a launcher rather than the program. Under Bun it hands straight
 * over. Under node it re-execs the real entry with Bun, and if Bun is not
 * installed it says so in a sentence a person can act on, which matters
 * because `engines` is advisory: npm warns and installs anyway.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'src', 'index.ts')
const args = process.argv.slice(2)

// Already Bun, so there is nothing to launch: import the program and let it
// own the process. This is the `bunx aalai` path, and it avoids paying for a
// second runtime start.
if (typeof globalThis.Bun !== 'undefined') {
  await import(pathToFileURL(entry).href)
} else {
  run(await findBun())
}

/**
 * Where Bun is, or null.
 *
 * PATH first, because that is what an installed Bun looks like. The default
 * install location is the fallback: a GUI terminal, a cron entry or an npx
 * invocation from an editor may not have the shell profile that adds it.
 */
async function findBun() {
  const onPath = await canRun('bun')
  if (onPath) {
    return 'bun'
  }
  const installed = join(homedir(), '.bun', 'bin', 'bun')
  return existsSync(installed) ? installed : null
}

function canRun(command) {
  return new Promise((resolve) => {
    const probe = spawn(command, ['--version'], { stdio: 'ignore' })
    probe.on('error', () => resolve(false))
    probe.on('close', (code) => resolve(code === 0))
  })
}

function run(bun) {
  if (bun === null) {
    process.stderr.write(
      [
        'aalai runs on Bun, and Bun was not found.',
        '',
        'Install it, then use bunx rather than npx:',
        '',
        '  curl -fsSL https://bun.sh/install | bash',
        '  bunx aalai',
        '',
        'npx works too once Bun is installed, but it starts node first and',
        'node then hands straight over to Bun, so bunx is one process fewer.',
        '',
        'The factory reads and writes through Bun APIs, sqlite and the',
        'filesystem among them, and ships as TypeScript. node cannot run it',
        'directly, which is why this is a launcher rather than the program.',
        '',
      ].join('\n'),
    )
    process.exit(127)
  }

  const child = spawn(bun, ['run', entry, ...args], { stdio: 'inherit' })

  // Forwarded rather than handled here: the factory finishes the tick it is
  // on when interrupted, and swallowing the signal would leave it running
  // after the terminal that started it has gone.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal))
  }

  child.on('error', (error) => {
    process.stderr.write(`aalai could not start Bun: ${error.message}\n`)
    process.exit(127)
  })
  child.on('close', (code, signal) => {
    // A signalled exit has no code. Reporting the conventional 128+n keeps
    // `echo $?` meaningful for whatever called this.
    process.exit(signal === null ? (code ?? 0) : 128 + osSignal(signal))
  })
}

function osSignal(name) {
  return { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 }[name] ?? 0
}
