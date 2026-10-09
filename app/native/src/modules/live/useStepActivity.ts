import { activityKey, NO_ACTIVITY, type SubjectActivity } from 'aalai/shared'
import { useSyncExternalStore } from 'react'
import { activityOf, subscribeToActivity } from '@/modules/live/$stepActivity'

/**
 * What a station is doing on one subject, right now.
 *
 * `useSyncExternalStore` rather than state plus an effect, because the store
 * changes several times a second and this is the case it exists for: React
 * stays consistent with an outside source without a render pass per event
 * whose only job is to copy the value in.
 */
export function useStepActivity(
  subject: { repo: string; number: number } | null,
  /**
   * What the server said was happening when this screen loaded.
   *
   * The store only knows what has come down the stream since the page opened,
   * so without this a thread loaded between two reports is blank until the
   * next one. The moment a live event arrives the store takes over.
   */
  seed?: SubjectActivity | null,
): SubjectActivity {
  const key = subject === null ? '' : activityKey(subject.repo, subject.number)
  const live = useSyncExternalStore(
    subscribeToActivity,
    () => activityOf(key),
    () => activityOf(key),
  )
  return live === NO_ACTIVITY ? (seed ?? NO_ACTIVITY) : live
}
