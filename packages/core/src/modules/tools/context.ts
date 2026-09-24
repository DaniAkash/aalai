import type { StationId } from '@/events/events.types'
import type { RunRef, Subject } from '@/modules/work/paths'

/**
 * What a tool call is allowed to touch.
 *
 * A call arrives over HTTP knowing nothing about which run made it, so the
 * target cannot come from the call: an issue body is attacker controlled text,
 * and a station talked into naming its own target is a station that can write
 * an artifact onto somebody else's repository. The token in the URL names the
 * run, and the tool writes where the token says.
 */
export interface ToolContext {
  readonly runId: string
  /** The subject's title, for artifact headings. */
  readonly title: string
  readonly subject: Subject
  readonly run: RunRef
  readonly station: StationId
}

/**
 * Tokens live in memory and die with the process.
 *
 * They are credentials for writing artifacts and queueing outbound comments,
 * so not persisting them is the point rather than a shortcut. A restart ends
 * every turn that was in flight anyway, and the machine mints a fresh token
 * when it re-enters the station.
 */
const contexts = new Map<string, ToolContext>()

export function grantToolAccess(context: ToolContext): string {
  const token = crypto.randomUUID()
  contexts.set(token, context)
  return token
}

export function resolveToolAccess(token: string): ToolContext | undefined {
  return contexts.get(token)
}

/** Called when a station's turn ends, so the token cannot outlive it. */
export function revokeToolAccess(token: string): void {
  contexts.delete(token)
}

/** Test seam, and the reset a long lived process would otherwise never get. */
export function activeToolGrants(): number {
  return contexts.size
}
