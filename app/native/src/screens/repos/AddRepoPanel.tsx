import type { PickerRow } from 'aalai/shared'
import { Search, X } from 'lucide-react'
import type { RefObject } from 'react'
import { ErrorNote } from '@/components/state'
import { useWatchRepos } from '@/modules/api/repos.hooks'
import type { AccessibleRepo } from '@/modules/api/repos.infinite'
import { OwnerHeader, renderRow, SkeletonRow } from './add-repo.components'
import { PolicyChoice, ScopeStrip } from './add-repo.controls'
import { useRepoPicker, VIEWPORT } from './add-repo.hooks'

const PINNED_HEIGHT = 34

/**
 * Choosing repositories to watch.
 *
 * Everything here is shaped by one number: the account this was built against
 * reaches around three hundred and seventy repositories across ten owners.
 * That is why the list pages, why it is virtualized, why search runs on GitHub
 * rather than over what has already loaded, and why several can be picked at
 * once and added under one policy.
 */
export function AddRepoPanel({
  watched,
  onDone,
}: {
  watched: readonly string[]
  onDone: () => void
}) {
  const picker = useRepoPicker(watched)
  const watch = useWatchRepos({
    onSuccess: () => {
      picker.clear()
      onDone()
    },
  })

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-border bg-popover">
      <div className="px-4 pt-4">
        <h2 className="font-heading font-semibold text-[15px]">
          Add a repository
        </h2>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          Pick as many as you like. They all start on the same policy, which you
          can change per repository afterwards.
        </p>
      </div>

      <div className="mx-4 mt-3 flex h-10 items-center gap-2 rounded-lg border border-border bg-background px-3 focus-within:border-ring">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          value={picker.term}
          onChange={(e) => picker.setTerm(e.target.value)}
          placeholder="Search your repositories and organizations"
          aria-label="Search repositories"
          data-testid="repo-search"
          className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none"
        />
        <button
          type="button"
          aria-label="Close the repository picker"
          onClick={onDone}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <ScopeStrip
        owners={picker.owners}
        value={picker.scope}
        onChange={picker.chooseScope}
      />

      <div className="relative mt-3 border-border border-t">
        <PickerBody picker={picker} />
      </div>

      <PolicyChoice value={picker.policy} onChange={picker.setPolicy} />

      <div className="flex items-center gap-2 px-4 pt-3 pb-4">
        {picker.selected.size > 0 ? (
          <button
            type="button"
            onClick={picker.clear}
            className="min-h-9 rounded-lg px-3 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Clear
          </button>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onDone}
          className="min-h-9 rounded-lg px-3 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="repo-add"
          disabled={picker.selected.size === 0 || watch.isPending}
          onClick={() =>
            watch.mutate({
              repos: [...picker.selected],
              policy: picker.policy,
            })
          }
          className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-primary px-3.5 font-semibold text-[12.5px] text-primary-foreground disabled:opacity-40"
        >
          Add
          <span className="grid h-[17px] min-w-[17px] place-items-center rounded-full bg-primary-foreground px-1 text-[10.5px] text-primary tabular-nums">
            {picker.selected.size}
          </span>
        </button>
      </div>
    </div>
  )
}

/**
 * The four things the list can be.
 *
 * Every one of them is rendered somewhere a reviewer can reach, because a list
 * that only ever shows its loaded state is how an empty or failing one ships
 * without anybody having seen it.
 */
function PickerBody({ picker }: { picker: ReturnType<typeof useRepoPicker> }) {
  if (picker.bodyState === 'error') {
    return (
      <div className="p-4">
        <ErrorNote
          message={picker.error?.message ?? 'Could not reach GitHub'}
          onRetry={picker.retry}
        />
      </div>
    )
  }
  if (picker.bodyState === 'first-load') {
    return (
      <div data-testid="repo-first-load">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-[52px]">
            <SkeletonRow />
          </div>
        ))}
      </div>
    )
  }
  if (picker.bodyState === 'empty') {
    return (
      <div className="px-4 py-10 text-center" data-testid="repo-empty">
        <h3 className="font-semibold text-[13.5px]">
          No repository matches that
        </h3>
        <p className="mx-auto mt-1 max-w-[34ch] text-[12.5px] text-muted-foreground">
          Search covers everything the signed in account can reach, across every
          organization, not just what has loaded.
        </p>
      </div>
    )
  }
  return <VirtualRows picker={picker} />
}

function VirtualRows({ picker }: { picker: ReturnType<typeof useRepoPicker> }) {
  const { rows, items, virtual, selected, watchedSet, toggle, pinned } = picker
  return (
    <>
      <div
        ref={picker.scrollRef as RefObject<HTMLDivElement>}
        data-testid="repo-list"
        // The rows are role="option", so the scroller is their listbox. A bare
        // div cannot carry the label, and the label is what is announced when
        // focus lands somewhere in a few hundred rows.
        role="listbox"
        aria-multiselectable="true"
        aria-label="Repositories"
        className="overflow-y-auto overscroll-contain"
        style={{ height: VIEWPORT }}
      >
        <div
          className="relative w-full"
          style={{ height: virtual.getTotalSize() }}
        >
          {items.map((item) => {
            const row: PickerRow<AccessibleRepo> | undefined = rows[item.index]
            return (
              <div
                key={row?.key ?? `pending:${item.index}`}
                className="absolute inset-x-0 top-0"
                style={{
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {row === undefined ? (
                  <SkeletonRow />
                ) : (
                  renderRow(row, selected, watchedSet, toggle)
                )}
              </div>
            )
          })}
        </div>
      </div>
      {pinned?.kind === 'header' ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-10"
          style={{ height: PINNED_HEIGHT }}
          data-testid="pinned-owner"
        >
          <OwnerHeader owner={pinned.owner} ownerType={pinned.ownerType} />
        </div>
      ) : null}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-popover to-transparent" />
    </>
  )
}
