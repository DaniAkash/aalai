import type { RunEvent } from 'aalai/events'
import {
  activityKeyOfRun,
  advanceActivity,
  NO_ACTIVITY,
  type SubjectActivity,
} from 'aalai/shared'

/**
 * Where live step activity is held, which is nowhere durable.
 *
 * Everywhere else the event stream invalidates the query cache and the screens
 * read one source of truth. That is right for facts with a home: a gate
 * answered, an artifact written. Progress has no home, so a refetch would
 * return a thread that knows nothing about it, and there is no cache to make
 * honest. This holds it instead, and is deliberately the only such store.
 *
 * The reduction lives in the shared package where it is tested. This is the
 * part that cannot be: a map, a set of listeners, and nothing else.
 *
 * It is lost on reload, which is correct. A count from a run that has since
 * finished is worse than no count.
 */

const bySubject = new Map<string, SubjectActivity>()
const listeners = new Set<() => void>()

/** Feeds the store. Called from the one subscription the app already has. */
export function recordStepEvent(event: RunEvent): void {
  const key = activityKeyOfRun(event.runId)
  if (key === '') {
    return
  }
  const before = bySubject.get(key) ?? NO_ACTIVITY
  const after = advanceActivity(before, event)
  if (after === before) {
    return
  }
  bySubject.set(key, after)
  for (const listener of listeners) {
    listener()
  }
}

export function activityOf(key: string): SubjectActivity {
  return bySubject.get(key) ?? NO_ACTIVITY
}

export function subscribeToActivity(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
