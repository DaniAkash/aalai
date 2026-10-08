import type { InferResponseType } from 'hono/client'
import { createQuery } from 'react-query-kit'
import { api } from '@/modules/api/client'
import { parseResponse } from '@/modules/api/parse'

type Client = Awaited<ReturnType<typeof api>>
type DetailResponse = InferResponseType<
  Client['api']['work'][':id']['$get'],
  200
>

/** One turn, spelled out so an export never leans on a private type. */
export type Turn = InferResponseType<
  Awaited<ReturnType<typeof api>>['api']['work'][':id']['$get'],
  200
>['turns'][number]

/** What a person is being asked to allow, when they are. */
export type Awaiting = InferResponseType<
  Awaited<ReturnType<typeof api>>['api']['work'][':id']['$get'],
  200
>['awaiting']

interface DetailVars {
  id: string
}

/**
 * One piece of work and everything that happened to it.
 *
 * Not polled. The thread is history, and history does not change on its own:
 * what changes it is an answer given on this screen, which invalidates it
 * directly. A poll would spend a request every few seconds to learn nothing.
 */
export const useWorkDetail = createQuery<DetailResponse, DetailVars>({
  queryKey: ['work', 'detail'],
  fetcher: async ({ id }) => {
    const client = await api()
    return parseResponse<DetailResponse>(
      await client.api.work[':id'].$get({ param: { id } }),
    )
  },
})
