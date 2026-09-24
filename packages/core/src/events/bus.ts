import type { RunEvent, RunLog } from '@/events/events.types'
import { redactDeep } from '@/lib/redact'

/** How many events one run keeps. Long enough to replay a full run into a late subscriber. */
const RING_SIZE = 400

/** How many finished runs stay in memory for the UI to scroll back through. */
const MAX_RUNS = 20

type Listener = (event: RunEvent) => void

const listeners = new Set<Listener>()
const logs = new Map<string, RunEvent[]>()
const order: string[] = []
/** Per-run redaction root, set when the run starts. */
const roots = new Map<string, string>()

/**
 * Registers the worktree a run will report from.
 *
 * Every event carries agent-authored strings that can name absolute paths, and
 * those reach a screen that may be projected or recorded. Redaction happens
 * here rather than at each call site, so a new emit cannot forget it.
 */
export function registerRunRoot(runId: string, worktree: string): void {
  roots.set(runId, worktree)
}

export function emit(event: RunEvent): void {
  const root = roots.get(event.runId)
  const safe = root === undefined ? event : redactDeep(event, root)

  const log = logs.get(event.runId) ?? []
  log.push(safe)
  if (log.length > RING_SIZE) {
    log.splice(0, log.length - RING_SIZE)
  }
  if (!logs.has(event.runId)) {
    logs.set(event.runId, log)
    order.push(event.runId)
    while (order.length > MAX_RUNS) {
      const evicted = order.shift()
      if (evicted !== undefined) {
        logs.delete(evicted)
        roots.delete(evicted)
      }
    }
  }

  for (const listener of listeners) {
    // One slow or broken subscriber must not take a run down with it.
    try {
      listener(safe)
    } catch {
      // Subscribers are observers. Their failures are theirs.
    }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Everything emitted so far, so a subscriber that arrives late still sees the run. */
export function replay(runId: string): readonly RunEvent[] {
  return logs.get(runId) ?? []
}

export function activeRuns(): readonly RunLog[] {
  return order.map((runId) => ({ runId, events: logs.get(runId) ?? [] }))
}

/** The run most recently started, which is what a dashboard opens on. */
export function latestRunId(): string | null {
  return order.at(-1) ?? null
}

/** Test seam. */
export function resetBus(): void {
  listeners.clear()
  logs.clear()
  roots.clear()
  order.length = 0
}
