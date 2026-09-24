import type { InferRequestType, InferResponseType } from 'hono/client'
import { createMutation, createQuery } from 'react-query-kit'
import { api } from '@/modules/api/client'
import { parseResponse } from '@/modules/api/parse'
import { queryClient } from '@/modules/api/queryClient'

type Client = Awaited<ReturnType<typeof api>>
type ReposResponse = InferResponseType<Client['api']['repos']['$get']>
type OwnedResponse = InferResponseType<Client['api']['github']['repos']['$get']>

export const useWatchedRepos = createQuery<ReposResponse>({
  queryKey: ['repos'],
  fetcher: async () => {
    const client = await api()
    return parseResponse<ReposResponse>(await client.api.repos.$get())
  },
})

/** What the signed in gh account can act on. Slow, so it is only asked for on demand. */
export const useOwnedRepos = createQuery<OwnedResponse>({
  queryKey: ['github', 'repos'],
  fetcher: async () => {
    const client = await api()
    return parseResponse<OwnedResponse>(await client.api.github.repos.$get())
  },
  staleTime: 5 * 60 * 1000,
})

export const useWatchRepo = createMutation<ReposResponse, { repo: string }>({
  mutationFn: async (vars) => {
    const client = await api()
    return parseResponse<ReposResponse>(
      await client.api.repos.$post({ json: vars }),
    )
  },
  onSettled: () => {
    void queryClient.invalidateQueries({ queryKey: useWatchedRepos.getKey() })
  },
})

export const useUnwatchRepo = createMutation<ReposResponse, { repo: string }>({
  mutationFn: async ({ repo }) => {
    const [owner, name] = repo.split('/')
    const client = await api()
    return parseResponse<ReposResponse>(
      await client.api.repos[':owner'][':name'].$delete({
        param: { owner: owner as string, name: name as string },
      }),
    )
  },
  onSettled: () => {
    void queryClient.invalidateQueries({ queryKey: useWatchedRepos.getKey() })
  },
})

type PatchBody = InferRequestType<
  Client['api']['repos'][':owner'][':name']['$patch']
>['json']

/**
 * Changes one repository's policy.
 *
 * Per repository rather than global, because a toy repository and the day job
 * should never share how much happens without a person.
 */
export const useSetRepoPolicy = createMutation<
  ReposResponse,
  { repo: string } & PatchBody
>({
  mutationFn: async ({ repo, ...patch }) => {
    const [owner, name] = repo.split('/')
    const client = await api()
    return parseResponse<ReposResponse>(
      await client.api.repos[':owner'][':name'].$patch({
        param: { owner: owner as string, name: name as string },
        json: patch,
      }),
    )
  },
  onSettled: () => {
    void queryClient.invalidateQueries({ queryKey: useWatchedRepos.getKey() })
  },
})
