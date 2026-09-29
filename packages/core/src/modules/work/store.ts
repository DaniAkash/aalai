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
  readonly kind: 'comment_on_issue' | 'reply_to_review' | 'close_issue'
  readonly body: string
  readonly threadId?: string
  readonly station: string
  readonly queuedAt: string
  /**
   * The gate whose answer releases this.
   *
   * Nothing is delivered until a person has answered the question it belongs
   * to, so an intent that names no gate is not deliverable at all. Optional
   * only because runs queued before this existed have none, and those are not
   * deliverable either.
   */
  readonly gateId?: string
  /** How to close, when closing. GitHub renders the two differently. */
  readonly closeReason?: 'completed' | 'not_planned'
}

/** An intent and the name it is filed under, which is what marks it delivered. */
export interface QueuedIntent {
  readonly id: string
  readonly intent: OutboundIntent
}

/** What happened when an intent was delivered. Written beside it, never over it. */
export interface DeliveryRecord {
  readonly deliveredAt: string
  /** The comment GitHub created, when the intent created one. */
  readonly url?: string
}

export async function queueOutbound(
  ref: RunRef,
  intent: OutboundIntent,
): Promise<string> {
  const path = join(runDir(ref), 'outbox', `${crypto.randomUUID()}.json`)
  await writeAtomic(path, `${JSON.stringify(intent, null, 2)}\n`)
  return path
}

/** Everything queued for this run, oldest first, with what it is filed under. */
export async function readQueued(ref: RunRef): Promise<QueuedIntent[]> {
  const dir = join(runDir(ref), 'outbox')
  const glob = new Bun.Glob('*.json')
  const queued: QueuedIntent[] = []
  try {
    for await (const name of glob.scan({ cwd: dir, onlyFiles: true })) {
      if (name.endsWith('.delivered.json')) {
        continue
      }
      queued.push({
        id: name.replace(/\.json$/, ''),
        intent: (await Bun.file(join(dir, name)).json()) as OutboundIntent,
      })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  return queued.sort((a, b) =>
    a.intent.queuedAt.localeCompare(b.intent.queuedAt),
  )
}

/**
 * Whether this intent has already gone out, and what happened when it did.
 *
 * Written beside the intent rather than into it, so the thing that was queued
 * and the fact that it was sent stay separately true.
 */
export async function readDelivery(
  ref: RunRef,
  id: string,
): Promise<DeliveryRecord | undefined> {
  const file = Bun.file(join(runDir(ref), 'outbox', `${id}.delivered.json`))
  try {
    return (await file.json()) as DeliveryRecord
  } catch {
    return undefined
  }
}

export async function recordDelivery(
  ref: RunRef,
  id: string,
  record: DeliveryRecord,
): Promise<void> {
  await writeAtomic(
    join(runDir(ref), 'outbox', `${id}.delivered.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  )
}

/** Everything queued for this run, oldest first. */
export async function readOutbound(ref: RunRef): Promise<OutboundIntent[]> {
  const dir = join(runDir(ref), 'outbox')
  const glob = new Bun.Glob('*.json')
  const intents: OutboundIntent[] = []
  try {
    for await (const name of glob.scan({ cwd: dir, onlyFiles: true })) {
      if (name.endsWith('.delivered.json')) {
        continue
      }
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
