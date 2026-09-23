import { createQuery } from 'react-query-kit'
import { api } from '@/modules/api/client'
import { parseResponse } from '@/modules/api/parse'
import type { InferResponseType } from 'hono/client'

type RunsResponse = InferResponseType<
  Awaited<ReturnType<typeof api>>['api']['runs']['$get']
>

export const usePastRuns = createQuery<RunsResponse>({
  queryKey: ['runs'],
  fetcher: async () => {
    const client = await api()
    return parseResponse<RunsResponse>(await client.api.runs.$get())
  },
})
