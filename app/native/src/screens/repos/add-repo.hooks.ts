import { useVirtualizer } from '@tanstack/react-virtual'
import {
  type PickerRow,
  pinnedHeader,
  type RunPolicy,
  rowHeight,
} from 'aalai/shared'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRepoFeed } from './add-repo.feed'

export const VIEWPORT = 324
const OVERSCAN = 6
const DEBOUNCE_MS = 220
const FALLBACK_ROW = 52
/** Placeholders for the page being fetched, so the end of the list is reachable. */
const PENDING_ROWS = 2

/**
 * What the picker is currently showing and what has been chosen in it.
 *
 * The queries live in `useRepoFeed`; this is the part that belongs to the
 * person using the panel rather than to the data: what they typed, which owner
 * they narrowed to, what they ticked, and which policy it all lands on.
 */
export function useRepoPicker(watched: readonly string[]) {
  const [term, setTerm] = useState('')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  // The plan gate rather than automatic. Adding a repository should not
  // quietly sign it up for unattended pull requests.
  const [policy, setPolicy] = useState<RunPolicy>('plan_gate')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)

  // Debounced because each change is a request to GitHub's search endpoint,
  // not a filter over an array already in memory.
  useEffect(() => {
    const id = setTimeout(() => setQuery(term.trim()), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [term])

  const feed = useRepoFeed(query, scope)
  const { rows, hasNext, fetching, fetchNext } = feed

  const virtual = useVirtualizer({
    count: rows.length + (hasNext ? PENDING_ROWS : 0),
    getScrollElement: () => scrollRef.current,
    // Headers and repositories differ in height, so the estimate is per index.
    // One number for both makes the scrollbar lie about how much is left.
    estimateSize: (i) => {
      const row = rows[i]
      return row === undefined ? FALLBACK_ROW : rowHeight(row)
    },
    overscan: OVERSCAN,
  })

  const items = virtual.getVirtualItems()
  const lastIndex = items[items.length - 1]?.index ?? 0
  const rowCount = rows.length

  // Driven by what is rendered rather than by a scroll handler, so it follows
  // the window instead of a pixel threshold that has to be kept in step with
  // the row heights.
  useEffect(() => {
    if (hasNext && !fetching && lastIndex >= rowCount - 1) {
      fetchNext()
    }
  }, [hasNext, fetching, fetchNext, lastIndex, rowCount])

  const watchedSet = useMemo(
    () => new Set(watched) as ReadonlySet<string>,
    [watched],
  )

  return {
    ...feed,
    term,
    setTerm,
    scope,
    chooseScope: (next: string) => {
      setScope(next)
      scrollRef.current?.scrollTo({ top: 0 })
    },
    policy,
    setPolicy,
    selected,
    toggle: (repo: string) => setSelected((prev) => flip(prev, repo)),
    clear: () => setSelected(new Set()),
    virtual,
    items,
    scrollRef,
    pinned: pinnedHeader(rows, items[0]?.index ?? 0) as PickerRow | undefined,
    watchedSet,
  }
}

function flip(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set)
  if (next.has(value)) {
    next.delete(value)
  } else {
    next.add(value)
  }
  return next
}
