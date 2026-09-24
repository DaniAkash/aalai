import type { StationId } from '@/events/events.types'
import type { ArtifactRef } from '@/modules/work/artifacts'
import type { RunRef, Subject } from '@/modules/work/paths'
import type { OutboundIntent } from '@/modules/work/store'
import type { Analysis, Review } from '@/run/stations/schemas'

/**
 * What a tool call is allowed to touch.
 *
 * A call arrives over HTTP knowing nothing about which run made it, so the
 * target cannot come from the call: an issue body is attacker controlled text,
 * and a station talked into naming its own target is a station that can write
 * an artifact onto somebody else's repository. The token in the url names the
 * run, and the tool writes where the token says.
 */
export interface ToolContext {
  readonly runId: string
  /** The subject's title, for artifact headings. */
  readonly title: string
  readonly subject: Subject
  readonly run: RunRef
  readonly station: StationId
  /** The worktree paths are redacted against, so nothing stored leaks one. */
  readonly worktreePath: string
  /** What the tools wrote during this turn, in call order. */
  readonly written: ArtifactRef[]
  readonly queued: OutboundIntent[]
  /**
   * The structured values a tool validated, kept so the caller does not have
   * to read back what it just wrote or parse the same thing out of prose.
   */
  readonly recorded: { analysis?: Analysis; review?: Review }
}

/** A turn's authority to call tools, and the record of what it did with it. */
export interface ToolGrant {
  readonly token: string
  readonly context: ToolContext
}

/**
 * Tokens live in memory and die with the process.
 *
 * They authorise writing artifacts and queueing outbound comments, so not
 * persisting them is the point rather than a shortcut. A restart ends every
 * turn that was in flight anyway, and a station re-entered later is granted a
 * fresh one.
 */
const grants = new Map<string, ToolContext>()

export function grantToolAccess(
  context: Omit<ToolContext, 'written' | 'queued' | 'recorded'>,
): ToolGrant {
  const token = crypto.randomUUID()
  const full: ToolContext = {
    ...context,
    written: [],
    queued: [],
    recorded: {},
  }
  grants.set(token, full)
  return { token, context: full }
}

export function resolveToolAccess(token: string): ToolContext | undefined {
  return grants.get(token)
}

/** Called when a station's turn ends, so the token cannot outlive it. */
export function revokeToolAccess(token: string): void {
  grants.delete(token)
}

export function activeToolGrants(): number {
  return grants.size
}
