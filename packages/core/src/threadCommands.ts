import { loadConfig } from '@/config'
import { localUser } from '@/lib/env'
import { logger } from '@/lib/log'
import { bad, block, heading, note, ok } from '@/lib/output'
import { type ReplyResult, readThread, replyToGate } from '@/modules/gates'
import { waitedFor } from '@/shared/format'
import { openState } from '@/watch/state'

const log = logger('gates')

/**
 * Prints the discussion behind a gate.
 *
 * The whole point of this surface: if the conversation cannot be held from a
 * terminal then it was built in the wrong place, and the gate has quietly become
 * a property of an app rather than of the run.
 */
export async function showThread(args: readonly string[]): Promise<void> {
  const [gateId] = args
  if (gateId === undefined) {
    bad('usage: aalai thread <gate-id>')
    process.exitCode = 1
    return
  }
  const db = openState()
  const thread = await readThread(db, gateId)
  db.close()
  if (thread === undefined) {
    bad('no such gate', gateId)
    process.exitCode = 1
    return
  }
  heading('discussion')
  if (thread.entries.length === 0) {
    note('nothing said yet', 'reply to ask the analyst something')
    return
  }
  for (const entry of thread.entries) {
    heading(`${entry.author} · ${entry.role} · ${waitedFor(entry.at)} ago`)
    block(entry.body)
  }
  if (thread.state === 'answering') {
    note('the analyst is answering', 'run this again in a moment')
  }
}

/**
 * Says something at a gate without answering it.
 *
 * Goes through the API when a factory is running, so the parked run hears it on
 * the in-process bus immediately. Writing the entry directly works with nothing
 * running, and the run's own poll notices it within a couple of seconds.
 */
export async function replyCommand(args: readonly string[]): Promise<void> {
  const [gateId, ...rest] = args
  const body = rest.join(' ').trim()
  if (gateId === undefined || body === '') {
    bad('usage: aalai reply <gate-id> <what you want to say>')
    process.exitCode = 1
    return
  }
  const author = localUser()
  const viaApi = await replyThroughApi(gateId, body, author)
  if (viaApi !== null) {
    reportReply(viaApi)
    return
  }
  log.debug('no factory reachable, appending the reply directly')
  const db = openState()
  const result = await replyToGate(db, { gateId, body, author })
  db.close()
  reportReply(result)
}

function reportReply(result: ReplyResult): void {
  if (result.ok) {
    ok('said', result.entry.body.split('\n')[0] ?? '')
    note('the gate is still open', 'approve, ask for changes, or keep talking')
    return
  }
  const { refusal } = result
  if (refusal.kind === 'not_found') {
    bad('no such gate')
  } else if (refusal.kind === 'wrong_kind') {
    bad('only a plan gate takes a reply', refusal.kind_was)
  } else {
    bad('this gate is no longer open', refusal.status)
  }
  process.exitCode = 1
}

/** The API when one is listening, or null when there is none to talk to. */
async function replyThroughApi(
  gateId: string,
  body: string,
  author: string,
): Promise<ReplyResult | null> {
  const config = await loadConfig()
  try {
    const response = await fetch(
      `http://127.0.0.1:${config.uiPort}/api/gates/${encodeURIComponent(gateId)}/reply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, author }),
        signal: AbortSignal.timeout(1500),
      },
    )
    // A reachable server that refuses has still answered the question. Only an
    // unreachable one falls through to writing the entry directly.
    if (response.status === 401) {
      return null
    }
    return (await response.json()) as ReplyResult
  } catch {
    return null
  }
}
