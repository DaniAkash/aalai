import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type RunRef, runDir } from './paths'

/** A staging name nothing else will pick, in the target's own directory. */
export function stagingPath(path: string): string {
  return `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
}

/**
 * Writes that either land whole or not at all.
 *
 * A snapshot half written during a crash is worse than no snapshot, because
 * the path that reconciles state would read it and trust it. Writing to a
 * temporary name in the same directory and renaming makes the swap atomic,
 * and same-directory matters: rename is only atomic within a filesystem.
 */
export async function writeAtomic(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // Unique per call, not just per process: two writes to the same target from
  // one process would otherwise share a staging file, and each could rename or
  // remove the bytes the other was still writing.
  const temporary = stagingPath(path)
  try {
    await Bun.write(temporary, content)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Machine state for one run: structured, written once or twice, read whole.
 *
 * It stays under the run rather than the subject because nobody reads it as
 * prose, and it is not indexed because nothing queries across it.
 *
 * @returns The path written, which is what belongs in a database column.
 */
export async function writeJson<T>(
  ref: RunRef,
  name: string,
  value: T,
): Promise<string> {
  const path = join(runDir(ref), `${name}.json`)
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
  return path
}

export async function readJson<T>(
  ref: RunRef,
  name: string,
): Promise<T | undefined> {
  const file = Bun.file(join(runDir(ref), `${name}.json`))
  if (!(await file.exists())) {
    return undefined
  }
  return (await file.json()) as T
}
