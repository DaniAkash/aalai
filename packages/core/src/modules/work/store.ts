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

/**
 * An intent to say something outside this machine, written down rather than sent.
 *
 * A station that can post is a station that can post from a poisoned issue
 * body, so anything outbound lands here and is delivered by aalai once whoever
 * has to see it has seen it.
 */
export interface OutboundIntent {
  readonly kind: 'comment_on_issue' | 'reply_to_review'
  readonly body: string
  readonly threadId?: string
  readonly station: string
  readonly queuedAt: string
}

export async function queueOutbound(
  ref: RunRef,
  intent: OutboundIntent,
): Promise<string> {
  const path = join(runDir(ref), 'outbox', `${crypto.randomUUID()}.json`)
  await writeAtomic(path, `${JSON.stringify(intent, null, 2)}\n`)
  return path
}

/** Everything queued for this run, oldest first. */
export async function readOutbound(ref: RunRef): Promise<OutboundIntent[]> {
  const dir = join(runDir(ref), 'outbox')
  const glob = new Bun.Glob('*.json')
  const intents: OutboundIntent[] = []
  try {
    for await (const name of glob.scan({ cwd: dir, onlyFiles: true })) {
      intents.push((await Bun.file(join(dir, name)).json()) as OutboundIntent)
    }
  } catch (error) {
    // A run that queued nothing has no outbox, and asking what it queued is
    // an ordinary question with the answer "nothing".
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  return intents.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
}
