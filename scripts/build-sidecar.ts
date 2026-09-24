/**
 * Compiles the factory into the standalone binary Tauri bundles as a sidecar.
 *
 * Tauri resolves an externalBin by appending the target triple to the name, so
 * the file on disk must carry it. Passing no argument builds for this machine.
 *
 * Bundling and `tauri dev` want it in two different places. A bundle reads
 * `binaries/aalai-core-<triple>`; a dev run resolves the sidecar next to the
 * compiled app instead, under `target/<profile>/aalai-core` with no triple, and
 * nothing else puts it there. Without the second copy the app panics on launch
 * with a bare `No such file or directory`, which names neither the file it
 * wanted nor where it looked.
 */

import { copyFile, exists, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { $ } from 'bun'
import { ok } from '../packages/core/src/lib/output'

const TRIPLES: Record<string, string> = {
  'aarch64-apple-darwin': 'bun-darwin-arm64',
  'x86_64-apple-darwin': 'bun-darwin-x64',
  'x86_64-unknown-linux-gnu': 'bun-linux-x64',
  'aarch64-unknown-linux-gnu': 'bun-linux-arm64',
  'x86_64-pc-windows-msvc': 'bun-windows-x64',
}

const root = join(import.meta.dir, '..')
const outDir = join(root, 'app', 'native', 'src-tauri', 'binaries')

async function hostTriple(): Promise<string> {
  const out = await $`rustc -vV`.text()
  const line = out.split('\n').find((l) => l.startsWith('host:'))
  if (!line) throw new Error('could not read the host triple from rustc')
  return line.slice('host:'.length).trim()
}

const triple = process.argv[2] ?? (await hostTriple())
const target = TRIPLES[triple]
if (!target)
  throw new Error(
    `no bun target for ${triple}. Known: ${Object.keys(TRIPLES).join(', ')}`,
  )

await mkdir(outDir, { recursive: true })
const suffix = triple.includes('windows') ? '.exe' : ''
const out = join(outDir, `aalai-core-${triple}${suffix}`)

await $`bun build --compile --target=${target} --outfile=${out} ${join(root, 'packages', 'core', 'src', 'index.ts')}`
ok('sidecar built', out)

// Only for the host's own triple: a cross compiled binary cannot run here, so
// copying it next to a dev build would be worse than not having one.
if (triple === (await hostTriple())) {
  const target = join(root, 'app', 'native', 'src-tauri', 'target')
  // debug is created rather than skipped when absent: on a fresh clone this
  // script runs before cargo has ever built, so waiting for the directory to
  // exist means the first `tauri dev` is the one that panics. release is only
  // topped up when a build has already made it.
  const profiles = [
    { dir: join(target, 'debug'), create: true },
    { dir: join(target, 'release'), create: false },
  ]
  for (const { dir, create } of profiles) {
    if (!create && !(await exists(dir))) {
      continue
    }
    await mkdir(dir, { recursive: true })
    const devCopy = join(dir, `aalai-core${suffix}`)
    await copyFile(out, devCopy)
    ok('sidecar placed for tauri dev', devCopy)
  }
}
