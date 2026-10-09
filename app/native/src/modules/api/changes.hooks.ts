import type { InferResponseType } from 'hono/client'
import { createQuery } from 'react-query-kit'
import { api } from '@/modules/api/client'
import { parseResponse } from '@/modules/api/parse'

type Client = Awaited<ReturnType<typeof api>>
type ChangesResponse = InferResponseType<
  Client['api']['work'][':id']['changes']['$get'],
  200
>

interface ChangesVars {
  id: string
}

interface PatchVars {
  id: string
  path: string
}

/** What this branch changed, as a list of files with their counts. */
export const useChanges = createQuery<ChangesResponse, ChangesVars>({
  queryKey: ['work', 'changes'],
  fetcher: async ({ id }) => {
    const client = await api()
    return parseResponse<ChangesResponse>(
      await client.api.work[':id'].changes.$get({
        param: { id },
        query: {},
      }),
    )
  },
})

/**
 * One file's patch, fetched only once a file is chosen.
 *
 * A branch can touch forty files and the pane shows one at a time, so loading
 * every patch to render a list of names would be most of the work for none of
 * the benefit. The caller passes `skipToken` until a file is chosen, which
 * keeps `path` a plain string here rather than one the fetcher has to re-check.
 */
export const useFilePatch = createQuery<
  { path: string; patch: string },
  PatchVars
>({
  queryKey: ['work', 'patch'],
  fetcher: async ({ id, path }) => {
    const client = await api()
    return parseResponse<{ path: string; patch: string }>(
      await client.api.work[':id'].changes.$get({
        param: { id },
        query: { path },
      }),
    )
  },
})
