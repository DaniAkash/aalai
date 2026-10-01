import type { InferResponseType } from 'hono/client'
import { createInfiniteQuery, createQuery } from 'react-query-kit'
import { api } from '@/modules/api/client'
import { parseResponse } from '@/modules/api/parse'

type Client = Awaited<ReturnType<typeof api>>
// Narrowed to 200: the route validates its query, so the inferred type
// otherwise also carries the validator's 400 body and every field read below
// becomes "does not exist on one member of the union".
type RepoPage = InferResponseType<Client['api']['github']['repos']['$get'], 200>
type OwnersResponse = InferResponseType<
  Client['api']['github']['owners']['$get']
>
/**
 * One repository as the route returns it.
 *
 * Spelled out from the client rather than through the page alias, so an
 * exported type never depends on a private one and the row components can be
 * typed without re-declaring the shape by hand.
 */
export type AccessibleRepo = InferResponseType<
  Awaited<ReturnType<typeof api>>['api']['github']['repos']['$get'],
  200
>['repos'][number]

/**
 * Every repository the account can reach, a page at a time.
 *
 * Infinite rather than one call: the account this was built against reaches
 * around three hundred and seventy across ten owners, and asking for all of
 * them to render a list that shows eight is why the old picker felt slow and
 * showed the wrong things.
 */
export const useAccessibleRepos = createInfiniteQuery<
  RepoPage,
  void,
  Error,
  number
>({
  queryKey: ['github', 'repos', 'pages'],
  fetcher: async (_vars, { pageParam }) => {
    const client = await api()
    return parseResponse<RepoPage>(
      await client.api.github.repos.$get({
        query: { page: String(pageParam) },
      }),
    )
  },
  initialPageParam: 1,
  // The server reports this from GitHub's Link header, so the end of the list
  // is known rather than inferred from a page that came back short.
  getNextPageParam: (last) => last.nextPage ?? undefined,
  staleTime: 5 * 60 * 1000,
})

/**
 * The same shape, for a term, resolved by GitHub rather than in the browser.
 *
 * Filtering the pages already loaded would answer a question about the first
 * page instead of about the account, and the repository being looked for is
 * usually the one that has not loaded yet.
 */
export const useSearchRepos = createInfiniteQuery<
  RepoPage,
  { q: string },
  Error,
  number
>({
  queryKey: ['github', 'repos', 'search'],
  fetcher: async (vars, { pageParam }) => {
    const client = await api()
    return parseResponse<RepoPage>(
      await client.api.github.repos.search.$get({
        query: { q: vars.q, page: String(pageParam) },
      }),
    )
  },
  initialPageParam: 1,
  getNextPageParam: (last) => last.nextPage ?? undefined,
  staleTime: 60 * 1000,
})

/** Asked for on its own because the scope strip exists before any page does. */
export const useRepoOwners = createQuery<OwnersResponse>({
  queryKey: ['github', 'owners'],
  fetcher: async () => {
    const client = await api()
    return parseResponse<OwnersResponse>(await client.api.github.owners.$get())
  },
  staleTime: 30 * 60 * 1000,
})
