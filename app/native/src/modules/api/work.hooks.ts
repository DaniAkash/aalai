import type { InferResponseType } from 'hono/client'
import { createQuery } from 'react-query-kit'
import { api } from '@/modules/api/client'
import { parseResponse } from '@/modules/api/parse'

type Client = Awaited<ReturnType<typeof api>>
type WorkResponse = InferResponseType<Client['api']['work']['$get']>

/**
 * One row of the work list.
 *
 * Spelled out from the client rather than through the response alias, so an
 * exported type never depends on a private one.
 */
export type WorkItem = InferResponseType<
  Awaited<ReturnType<typeof api>>['api']['work']['$get']
>['lanes'][number]['items'][number]

interface WorkVars {
  repo?: string
}

/**
 * Everything in play, grouped into lanes.
 *
 * Polled rather than streamed, for the same reason the queue is: the event bus
 * is keyed per run, and a row moving between lanes because a slot freed
 * belongs to no run.
 */
export const useWork = createQuery<WorkResponse, WorkVars>({
  queryKey: ['work'],
  fetcher: async (vars) => {
    const client = await api()
    return parseResponse<WorkResponse>(
      await client.api.work.$get({
        query: vars.repo === undefined ? {} : { repo: vars.repo },
      }),
    )
  },
  refetchInterval: 4000,
})
