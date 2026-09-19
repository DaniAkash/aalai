import { createQuery } from 'react-query-kit'
import type { PastRun } from '@/screens/run/run.types'

/**
 * Finished runs, from the service's own record.
 *
 * A Kit factory rather than a bare useQuery so the key lives with the hook and
 * anything invalidating it uses `pastRuns.getKey()` instead of a hand-written
 * string.
 */
export const usePastRuns = createQuery<readonly PastRun[]>({
  queryKey: ['runs'],
  fetcher: async (): Promise<readonly PastRun[]> => {
    const response = await fetch('/api/runs')
    if (!response.ok) {
      throw new Error(`the service returned ${response.status}`)
    }
    const body = (await response.json()) as { runs: readonly PastRun[] }
    return body.runs
  },
  refetchInterval: 15_000,
})
