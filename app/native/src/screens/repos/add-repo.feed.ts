import { flattenRows, type PickerRow } from 'aalai/shared'
import { useMemo } from 'react'
import {
  type AccessibleRepo,
  useAccessibleRepos,
  useRepoOwners,
  useSearchRepos,
} from '@/modules/api/repos.infinite'

export type BodyState = 'error' | 'first-load' | 'empty' | 'rows'

export interface RepoFeed {
  readonly rows: PickerRow<AccessibleRepo>[]
  readonly owners: { login: string; type: 'user' | 'org' }[]
  readonly bodyState: BodyState
  readonly error: Error | null
  readonly retry: () => void
  readonly hasNext: boolean
  readonly fetching: boolean
  readonly fetchNext: () => void
}

/**
 * The rows to draw, from whichever query is answering.
 *
 * Browsing and searching are two queries with one shape, swapped by whether a
 * term is set. Kept that way deliberately: the moment they are two components,
 * one of them gets the grouping and the sticky header and the other does not.
 */
export function useRepoFeed(query: string, scope: string): RepoFeed {
  const owners = useRepoOwners()
  const browse = useAccessibleRepos({ enabled: query === '' })
  const search = useSearchRepos({
    variables: { q: query },
    enabled: query !== '',
  })
  const active = query === '' ? browse : search

  const repos = useMemo(
    () => (active.data?.pages ?? []).flatMap((page) => page.repos),
    [active.data],
  )
  const ownerOrder = useMemo(
    () => (owners.data?.owners ?? []).map((owner) => owner.login),
    [owners.data],
  )
  const rows = useMemo(
    () =>
      flattenRows<AccessibleRepo>(
        scope === 'all' ? repos : repos.filter((r) => r.owner === scope),
        ownerOrder,
      ),
    [repos, ownerOrder, scope],
  )

  return {
    rows,
    owners: owners.data?.owners ?? [],
    bodyState: bodyStateOf(active.isError, active.isPending, rows.length),
    error: active.error,
    retry: () => void active.refetch(),
    hasNext: active.hasNextPage === true,
    fetching: active.isFetchingNextPage,
    fetchNext: () => void active.fetchNextPage(),
  }
}

function bodyStateOf(
  isError: boolean,
  isPending: boolean,
  rowCount: number,
): BodyState {
  if (isError) {
    return 'error'
  }
  if (isPending) {
    return 'first-load'
  }
  return rowCount === 0 ? 'empty' : 'rows'
}
