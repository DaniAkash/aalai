/**
 * The part of a repository this grouping needs.
 *
 * Declared structurally rather than imported from the route, so the shared
 * module stays free of anything the browser cannot have, and so the client's
 * inferred type satisfies it without a cast.
 */
export interface GroupableRepo {
  readonly repo: string
  readonly owner: string
  readonly ownerType: 'user' | 'org'
}

/**
 * How many repositories one add may carry.
 *
 * Shared because the route enforces it and the picker has to stop short of it
 * while choosing. Left to drift, the panel invites a selection the route then
 * rejects, and the only symptom is an Add button that appears to do nothing.
 */
export const MAX_REPOS_PER_ADD = 50

export const HEADER_ROW = 34
export const REPO_ROW = 52

export type PickerRow<T extends GroupableRepo = GroupableRepo> =
  | { kind: 'header'; key: string; owner: string; ownerType: 'user' | 'org' }
  | { kind: 'repo'; key: string; repo: T }

/**
 * Groups by owner into ONE array rather than a list per owner.
 *
 * A virtualizer needs a single index space, so sections cannot be nested
 * scrollers. Headers become rows of their own, which also makes pinning the
 * current owner possible: with nested scrollers there is nothing for a sticky
 * header to be sticky inside.
 */
export function flattenRows<T extends GroupableRepo>(
  repos: readonly T[],
  ownerOrder: readonly string[],
): PickerRow<T>[] {
  const byOwner = new Map<string, T[]>()
  for (const repo of repos) {
    const bucket = byOwner.get(repo.owner)
    if (bucket === undefined) {
      byOwner.set(repo.owner, [repo])
    } else {
      bucket.push(repo)
    }
  }
  // Owners the server listed come first and in its order, which puts the
  // signed in account above its organizations. Anything else, a repository
  // reached through a team rather than membership, follows in arrival order
  // rather than being dropped.
  const rank = new Map(ownerOrder.map((login, i) => [login, i]))
  const owners = [...byOwner.keys()].sort(
    (a, b) =>
      (rank.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
  )
  const rows: PickerRow<T>[] = []
  for (const owner of owners) {
    const group = byOwner.get(owner) ?? []
    const first = group[0]
    if (first === undefined) {
      continue
    }
    rows.push({
      kind: 'header',
      key: `h:${owner}`,
      owner,
      ownerType: first.ownerType,
    })
    for (const repo of group) {
      rows.push({ kind: 'repo', key: repo.repo, repo })
    }
  }
  return rows
}

export function rowHeight(row: PickerRow): number {
  return row.kind === 'header' ? HEADER_ROW : REPO_ROW
}

/** The owner whose section the top of the viewport is inside, if any. */
export function pinnedHeader(
  rows: readonly PickerRow[],
  firstVisible: number,
): PickerRow | undefined {
  for (let i = Math.min(firstVisible, rows.length - 1); i >= 0; i--) {
    const row = rows[i]
    if (row?.kind === 'header') {
      return row
    }
  }
  return undefined
}

/**
 * How recently a repository was pushed to, in the shortest true form.
 *
 * Exact dates on a list this long are noise: the question a picker answers is
 * "is this one still alive", not "which Tuesday".
 */
export function pushedLabel(iso: string): string {
  if (iso === '') {
    return ''
  }
  const then = Date.parse(iso)
  if (Number.isNaN(then)) {
    return ''
  }
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) {
    return 'pushed today'
  }
  if (days === 1) {
    return 'pushed yesterday'
  }
  if (days < 30) {
    return `pushed ${days}d ago`
  }
  if (days < 365) {
    return `pushed ${Math.floor(days / 30)}mo ago`
  }
  return `pushed ${Math.floor(days / 365)}y ago`
}

export function starsLabel(n: number): string {
  if (n === 0) {
    return ''
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k stars`
  }
  return n === 1 ? '1 star' : `${n} stars`
}
