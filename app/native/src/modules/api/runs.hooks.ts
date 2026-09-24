import type { InferResponseType } from 'hono/client'
import { createQuery } from 'react-query-kit'
import { api } from '@/modules/api/client'
import { parseResponse } from '@/modules/api/parse'

type Client = Awaited<ReturnType<typeof api>>
type RunsResponse = InferResponseType<
  Awaited<ReturnType<typeof api>>['api']['runs']['$get']
>

export const usePastRuns = createQuery<RunsResponse>({
  queryKey: ['runs'],
  // The factory claims and finishes runs on its own schedule, so an open
  // window has to ask. This is the floor until the event stream is wired in
  // to invalidate on the transitions that matter.
  refetchInterval: 5000,
  refetchOnWindowFocus: true,
  fetcher: async () => {
    const client = await api()
    return parseResponse<RunsResponse>(await client.api.runs.$get())
  },
})

type LiveResponse = InferResponseType<Client['api']['live'][':runId']['$get']>

type ActiveResponse = InferResponseType<Client['api']['live']['$get']>

/**
 * Which runs still have their events in memory.
 *
 * The history table knows a run happened; only the buffer knows what it said,
 * and it is keyed by a run id the table does not carry. This is what lets a
 * row in the list point at its own detail.
 */
export const useActiveRuns = createQuery<ActiveResponse>({
  queryKey: ['live', 'active'],
  fetcher: async () => {
    const client = await api()
    return parseResponse<ActiveResponse>(await client.api.live.$get())
  },
})

interface RunVars {
  readonly runId: string
}

/**
 * Everything one run has said, newest last.
 *
 * Read from the event buffer rather than the database, because what a run is
 * doing right now only exists there: the database holds how it ended.
 */
export const useRunEvents = createQuery<LiveResponse, RunVars>({
  queryKey: ['live'],
  fetcher: async ({ runId }) => {
    const client = await api()
    return parseResponse<LiveResponse>(
      // Encoded for the same reason a gate id is: the client inserts a path
      // parameter verbatim and a run id carries a slash.
      await client.api.live[':runId'].$get({
        param: { runId: encodeURIComponent(runId) },
      }),
    )
  },
})
