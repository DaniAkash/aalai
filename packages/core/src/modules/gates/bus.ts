import type { GateRow } from '@/modules/db/schema/schema'

export type GateListener = (gate: GateRow) => void

const listeners = new Set<GateListener>()

/**
 * Tells anything in this process that a gate was answered.
 *
 * An optimisation, never the mechanism. The CLI answering a gate runs in a
 * different process from the factory holding the machine, and nothing in
 * memory crosses that boundary, so the watcher's database poll is what
 * actually guarantees delivery. This only removes the wait when the answer
 * happens to arrive in the same process.
 */
export function publishGateAnswered(gate: GateRow): void {
  for (const listener of listeners) {
    try {
      listener(gate)
    } catch {
      // One bad subscriber must not stop the others being told.
    }
  }
}

export function subscribeGateAnswered(listener: GateListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
