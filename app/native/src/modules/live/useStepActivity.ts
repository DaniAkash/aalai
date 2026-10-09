import { activityKey, type SubjectActivity } from 'aalai/shared'
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
): SubjectActivity {
  const key = subject === null ? '' : activityKey(subject.repo, subject.number)
  return useSyncExternalStore(
    subscribeToActivity,
    () => activityOf(key),
    () => activityOf(key),
  )
}
