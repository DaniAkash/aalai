import { activityKey, NO_ACTIVITY } from 'aalai/shared'
import { useSyncExternalStore } from 'react'
import type { WorkItem } from '@/modules/api/work.hooks'
import { activityOf, subscribeToActivity } from '@/modules/live/$stepActivity'

/**
 * What each running row should say, read once for the whole list.
 *
 * One subscription rather than one per row. A list of forty rows subscribing
 * individually would wake forty components for a count that concerns one.
 */
export function useLiveRows(): (
  item: WorkItem,
) => { label: string; ratio: number | null } | null {
  useSyncExternalStore(
    subscribeToActivity,
    () => activityOf(''),
    () => activityOf(''),
  )
  return (item) => {
    // The store wins once anything has streamed in; the row falls back to
    // what the server said was happening when the list was fetched.
    const held = activityOf(activityKey(item.repo, item.number))
    const live = (held === NO_ACTIVITY ? item.activity : held)?.live ?? null
    if (live === null) {
      return null
    }
    // What the station called the step, which is what the prototype shows
    // here: a row has no room for the plan and no way to look one up.
    const name = live.label ?? `Step ${live.stepIndex + 1}`
    const progress = live.progress
    return progress === undefined
      ? { label: name, ratio: null }
      : {
          label: `${name}, ${progress.done} of ${progress.total} ${progress.unit}`,
          ratio: progress.done / progress.total,
        }
  }
}
