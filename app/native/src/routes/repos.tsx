import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Check, Lock, Plus, Search, X } from 'lucide-react'
import { useState } from 'react'
import { Empty, ErrorNote, Loading } from '@/components/state'
import {
  useOwnedRepos,
  useUnwatchRepo,
  useWatchRepo,
  useWatchedRepos,
} from '@/modules/api/repos.hooks'

export const Route = createFileRoute('/repos')({ component: ReposRoute })

/**
 * Watched repositories.
 *
 * This is the screen that makes the desktop app worth having: adding a repo is
 * a click on something the account already owns, not a hand edited JSON file
 * in a directory you have to be told about.
 */
function ReposRoute() {
  const [picking, setPicking] = useState(false)
  const watched = useWatchedRepos()
  const queryClient = useQueryClient()
  const refresh = () => void queryClient.invalidateQueries({ queryKey: useWatchedRepos.getKey() })
  const unwatch = useUnwatchRepo({ onSuccess: refresh })

  if (watched.isPending) return <><Head onAdd={() => setPicking(true)} /><Loading rows={3} /></>
  if (watched.isError) {
    return (
      <>
        <Head onAdd={() => setPicking(true)} />
        <ErrorNote message={watched.error.message} onRetry={() => watched.refetch()} />
      </>
    )
  }

  return (
    <>
      <Head onAdd={() => setPicking(true)} />
      {picking ? <Picker onDone={() => { setPicking(false); refresh() }} watched={watched.data.repos.map((r) => r.repo)} /> : null}

      {watched.data.repos.length === 0 && !picking ? (
        <Empty
          title="Nothing is being watched yet"
          detail="Add a repository you own and aalai will start picking up its issues."
          action={
            <button
              type="button"
              onClick={() => setPicking(true)}
              className="bg-primary text-primary-foreground rounded-lg px-3.5 py-2 text-[13px] font-medium"
            >
              Add a repo
            </button>
          }
        />
      ) : null}

      {watched.data.repos.map((repo) => (
        <div
          key={repo.repo}
          className="border-border bg-card mb-1.5 flex items-center gap-3 rounded-xl border p-3"
        >
          <span className="bg-chart-2 size-[7px] shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[13px]">{repo.repo}</div>
            <div className="text-muted-foreground font-mono text-[11.5px]">
              {repo.requireLabel ? `only issues labelled ${repo.requireLabel}` : 'every issue that passes the door'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => unwatch.mutate({ repo: repo.repo })}
            disabled={unwatch.isPending}
            className="text-muted-foreground hover:text-foreground border-border rounded-lg border px-2.5 py-1.5 text-[12px]"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </>
  )
}

function Picker({ watched, onDone }: { watched: string[]; onDone: () => void }) {
  const [filter, setFilter] = useState('')
  const owned = useOwnedRepos()
  const watch = useWatchRepo({ onSuccess: onDone })

  return (
    <div className="border-border bg-card mb-4 overflow-hidden rounded-xl border">
      <div className="border-border flex items-center gap-2.5 border-b px-3.5 py-2.5">
        <Search className="text-muted-foreground size-4" />
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter repositories you own"
          className="flex-1 bg-transparent text-[13.5px] outline-none"
        />
        <button type="button" onClick={onDone} className="text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      {owned.isPending ? <div className="p-3"><Loading rows={3} /></div> : null}
      {owned.isError ? (
        <div className="p-3"><ErrorNote message={owned.error.message} onRetry={() => owned.refetch()} /></div>
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
                className="border-border hover:bg-muted/50 flex w-full items-center gap-2.5 border-b px-3.5 py-2.5 text-left last:border-b-0 disabled:opacity-40"
              >
                {already ? <Check className="size-3.5 text-chart-2" /> : <Plus className="text-muted-foreground size-3.5" />}
                <span className="font-mono text-[12.5px]">{r.repo}</span>
                {r.isPrivate ? <Lock className="text-muted-foreground ml-auto size-3" /> : null}
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
        <h1 className="font-heading text-[19px] font-semibold tracking-tight">Repos</h1>
        <p className="text-muted-foreground text-[13px]">
          Policy is per repo. A toy repo and the day job should not share a setting.
        </p>
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="bg-primary text-primary-foreground flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium"
      >
        <Plus className="size-3.5" /> Add repo
      </button>
    </div>
  )
}
