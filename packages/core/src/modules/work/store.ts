import { closeSync, openSync, statSync, writeSync } from 'node:fs'
import { mkdir, rename, rm, unlink } from 'node:fs/promises'
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
  /**
   * A name for this intent, when the caller can produce the same one twice.
   *
   * Queueing sits outside the attempt that produced the judgement, so a crash
   * between writing these and persisting the transition replays them. A random
   * name would make that a second comment; a name derived from what the intent
   * is makes it the same one.
   */
  id?: string,
): Promise<string> {
  const path = join(runDir(ref), 'outbox', `${id ?? crypto.randomUUID()}.json`)
  await writeAtomic(path, `${JSON.stringify(intent, null, 2)}\n`)
  return path
}

/**
 * Binds every unreleased intent to the gate that now asks about it.
 *
 * A station queues an intent before the gate exists, because the gate is opened
 * on the artifact the station just wrote. This is the machine saying "these
 * belong to the question I am about to ask", which is what makes delivery able
 * to refuse anything a person has not answered.
 *
 * Only unbound intents are stamped: one already released by an earlier gate
 * keeps that gate, so re-asking a question cannot retroactively release what
 * the previous answer did not.
 */
/**
 * Throws away what has not gone out yet.
 *
 * A correction says the judgement was wrong, which makes everything that
 * judgement drafted wrong with it. Without this the reply written for a
 * question rides out later on the gate that approved the bug it was corrected
 * into, because a gate answered `reclassify` is still an answered gate.
 *
 * Only the undelivered are dropped. A delivery record is a record of something
 * a person has already seen, and no correction can take that back.
 */
export async function discardQueued(ref: RunRef): Promise<number> {
  let dropped = 0
  for (const queued of await readQueued(ref)) {
    // An intent that has been sent keeps its file beside its delivery record.
    // The pair is the audit trail, and deleting half of it would leave a record
    // of something posted with no way to see what it said.
    if ((await readDelivery(ref, queued.id)) !== undefined) {
      continue
    }
    await unlink(join(runDir(ref), 'outbox', `${queued.id}.json`))
    dropped += 1
  }
  return dropped
}

export async function bindIntentsToGate(
  ref: RunRef,
  gateId: string,
): Promise<number> {
  let bound = 0
  for (const queued of await readQueued(ref)) {
    if (queued.intent.gateId !== undefined) {
      continue
    }
    await writeAtomic(
      join(runDir(ref), 'outbox', `${queued.id}.json`),
      `${JSON.stringify({ ...queued.intent, gateId }, null, 2)}\n`,
    )
    bound += 1
  }
  return bound
}

/** Everything queued for this run, oldest first, with what it is filed under. */
/** Closing comes after saying why. */
function rank(kind: OutboundIntent['kind']): number {
  return kind === 'close_issue' ? 1 : 0
}

export async function readQueued(ref: RunRef): Promise<QueuedIntent[]> {
  const dir = join(runDir(ref), 'outbox')
  const glob = new Bun.Glob('*.json')
  const queued: QueuedIntent[] = []
  try {
    for await (const name of glob.scan({ cwd: dir, onlyFiles: true })) {
      if (name.endsWith('.delivered.json') || name.endsWith('.sending.json')) {
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
  // A close is the last thing that happens, whatever the clock says. Two
  // intents queued in the same millisecond would otherwise be ordered by
  // whatever order the directory happened to be read in, and closing an issue
  // before answering it is the wrong way round.
  return queued.sort(
    (a, b) =>
      a.intent.queuedAt.localeCompare(b.intent.queuedAt) ||
      rank(a.intent.kind) - rank(b.intent.kind),
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

/** How long a claim on an intent is believed before it is treated as abandoned. */
const CLAIM_STALE_MS = 10 * 60_000

/**
 * Takes exclusive ownership of one intent before it is sent.
 *
 * The check that an intent has not gone out is a read, the send is a network
 * call, and the record of it is a later write. Two workers can both pass the
 * read and both post, which is a duplicate comment under a maintainer's name on
 * a public issue. Stale claim takeover makes this ordinary rather than exotic:
 * a worker that lost its lease is still running.
 *
 * `wx` either creates the file or throws, with no window between the two, which
 * is the whole reason it is a file rather than a check. A claim older than the
 * window is taken over, because a process that died holding one must not park
 * the intent forever.
 */
export async function claimDelivery(ref: RunRef, id: string): Promise<boolean> {
  const path = join(runDir(ref), 'outbox', `${id}.sending.json`)
  await mkdir(dirname(path), { recursive: true })
  try {
    const handle = openSync(path, 'wx')
    writeSync(handle, `${JSON.stringify({ at: new Date().toISOString() })}\n`)
    closeSync(handle)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }
  const held = statSync(path, { throwIfNoEntry: false })
  if (held === undefined || Date.now() - held.mtimeMs < CLAIM_STALE_MS) {
    return false
  }
  // Abandoned. Taking it over is a write, so the loser of a race between two
  // takeovers simply finds it already gone on its next pass.
  await writeAtomic(
    path,
    `${JSON.stringify({ at: new Date().toISOString() })}\n`,
  )
  return true
}

/** Gives the claim back, so a failed send can be tried again. */
export async function releaseDelivery(ref: RunRef, id: string): Promise<void> {
  try {
    await unlink(join(runDir(ref), 'outbox', `${id}.sending.json`))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
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
      if (name.endsWith('.delivered.json') || name.endsWith('.sending.json')) {
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
