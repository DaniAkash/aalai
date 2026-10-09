import { activityKey } from 'aalai/shared'
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
    const live = activityOf(activityKey(item.repo, item.number)).live
    if (live === null) {
      return null
    }
    const progress = live.progress
    return progress === undefined
      ? { label: `step ${live.stepIndex + 1}`, ratio: null }
      : {
          label: `${progress.label}, ${progress.done} of ${progress.total} ${progress.unit}`,
          ratio: progress.done / progress.total,
        }
  }
}
