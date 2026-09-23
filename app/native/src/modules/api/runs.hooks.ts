import { createQuery } from 'react-query-kit'
import { api } from '@/modules/api/client'
import { parseResponse } from '@/modules/api/parse'
import type { InferResponseType } from 'hono/client'

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
