/**
 * Compiles the factory into the standalone binary Tauri bundles as a sidecar.
 *
 * Tauri resolves an externalBin by appending the target triple to the name, so
 * the file on disk must carry it. Passing no argument builds for this machine.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { $ } from 'bun'

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
