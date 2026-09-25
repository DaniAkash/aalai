import { useQueryClient } from '@tanstack/react-query'
import { Check, Lock, Plus, Search, X } from 'lucide-react'
import { useState } from 'react'
import { Empty, ErrorNote, Loading } from '@/components/state'
import {
  useOwnedRepos,
  useSetRepoPolicy,
  useUnwatchRepo,
  useWatchedRepos,
  useWatchRepo,
} from '@/modules/api/repos.hooks'
import { PolicyPicker } from './repos.components'

/**
 * Watched repositories.
 *
 * This is the screen that makes the desktop app worth having: adding a repo is
 * a click on something the account already owns, not a hand edited JSON file
 * in a directory you have to be told about.
 */
export function Repos() {
  const [picking, setPicking] = useState(false)
  const watched = useWatchedRepos()
  const queryClient = useQueryClient()
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: useWatchedRepos.getKey() })
  const unwatch = useUnwatchRepo({ onSuccess: refresh })
  const setPolicy = useSetRepoPolicy()

  if (watched.isPending)
    return (
      <>
        <Head onAdd={() => setPicking(true)} />
        <Loading rows={3} />
      </>
    )
  if (watched.isError) {
    return (
      <>
        <Head onAdd={() => setPicking(true)} />
        <ErrorNote
          message={watched.error.message}
          onRetry={() => watched.refetch()}
        />
      </>
    )
  }

  return (
    <>
      <Head onAdd={() => setPicking(true)} />
      {picking ? (
        <Picker
          onDone={() => {
            setPicking(false)
            refresh()
          }}
          watched={watched.data.repos.map((r) => r.repo)}
        />
      ) : null}

      {watched.data.repos.length === 0 && !picking ? (
        <Empty
          title="Nothing is being watched yet"
          detail="Add a repository you own and aalai will start picking up its issues."
          action={
            <button
              type="button"
              onClick={() => setPicking(true)}
              className="rounded-lg bg-primary px-3.5 py-2 font-medium text-[13px] text-primary-foreground"
            >
              Add a repo
            </button>
          }
        />
      ) : null}

      {watched.data.repos.map((repo) => (
        <div
          key={repo.repo}
          // Stacked by default, a row from md up. The policy picker cannot
          // shrink, so on a narrow row it takes the whole width and starves
          // the name to zero, which then paints underneath it.
          className="mb-1.5 flex flex-col items-stretch gap-2 rounded-xl border border-border bg-card p-3 md:flex-row md:items-center md:gap-3"
        >
          <span className="size-[7px] shrink-0 rounded-full bg-chart-2" />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[13px]">{repo.repo}</div>
            <div className="font-mono text-[11.5px] text-muted-foreground">
              {repo.requireLabel
                ? `only issues labelled ${repo.requireLabel}`
                : 'every issue that passes the door'}
            </div>
          </div>
          <PolicyPicker
            value={repo.policy ?? 'automatic'}
            pending={setPolicy.isPending}
            onChange={(policy) => setPolicy.mutate({ repo: repo.repo, policy })}
          />
          <button
            type="button"
            aria-label={`Stop watching ${repo.repo}`}
            onClick={() => unwatch.mutate({ repo: repo.repo })}
            disabled={unwatch.isPending}
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground hover:text-foreground md:min-h-0"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </>
  )
}

function Picker({
  watched,
  onDone,
}: {
  watched: string[]
  onDone: () => void
}) {
  const [filter, setFilter] = useState('')
  const owned = useOwnedRepos()
  const watch = useWatchRepo({ onSuccess: onDone })

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2.5 border-border border-b px-3.5 py-2.5">
        <Search className="size-4 text-muted-foreground" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter repositories you own"
          className="flex-1 bg-transparent text-[13.5px] outline-none"
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

      {owned.isPending ? (
        <div className="p-3">
          <Loading rows={3} />
        </div>
      ) : null}
      {owned.isError ? (
        <div className="p-3">
          <ErrorNote
            message={owned.error.message}
            onRetry={() => owned.refetch()}
          />
        </div>
      ) : null}

      <div className="max-h-72 overflow-y-auto">
        {owned.data?.repos
          .filter((r) => r.repo.toLowerCase().includes(filter.toLowerCase()))
          .slice(0, 50)
          .map((r) => {
            const already = watched.includes(r.repo)
            return (
              <button
                key={r.repo}
                type="button"
                disabled={already || watch.isPending}
                onClick={() => watch.mutate({ repo: r.repo })}
                className="flex w-full items-center gap-2.5 border-border border-b px-3.5 py-2.5 text-left last:border-b-0 hover:bg-muted/50 disabled:opacity-40"
              >
                {already ? (
                  <Check className="size-3.5 text-chart-2" />
                ) : (
                  <Plus className="size-3.5 text-muted-foreground" />
                )}
                <span className="font-mono text-[12.5px]">{r.repo}</span>
                {r.isPrivate ? (
                  <Lock className="ml-auto size-3 text-muted-foreground" />
                ) : null}
              </button>
            )
          })}
      </div>
    </div>
  )
}

function Head({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="mb-5 flex items-start">
      <div className="flex-1">
        <h1 className="font-heading font-semibold text-[19px] tracking-tight">
          Repos
        </h1>
        <p className="text-[13px] text-muted-foreground">
          Policy is per repo. A toy repo and the day job should not share a
          setting.
        </p>
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 font-medium text-[12.5px] text-primary-foreground md:min-h-0"
      >
        <Plus className="size-3.5" /> Add repo
      </button>
    </div>
  )
}
