import { createFileRoute } from '@tanstack/react-router'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Empty, ErrorNote, Loading } from '@/components/state'
import { usePastRuns } from '@/modules/api/runs.hooks'

export const Route = createFileRoute('/runs')({ component: RunsRoute })

// Keyed on the statuses the core actually emits.
const DOT: Record<string, string> = {
  claimed: 'bg-primary',
  delivered: 'bg-chart-2',
  failed: 'bg-destructive',
  skipped: 'bg-muted-foreground',
}

function RunsRoute() {
  const runs = usePastRuns()

  if (runs.isPending)
    return (
      <>
        <Head />
        <Loading rows={5} />
      </>
    )
  if (runs.isError)
    return (
      <>
        <Head />
        <ErrorNote
          message={runs.error.message}
          onRetry={() => runs.refetch()}
        />
      </>
    )
  if (runs.data.runs.length === 0) {
    return (
      <>
        <Head />
        <Empty
          title="No runs yet"
          detail="Once a watched repo gets an issue that passes the door, the run will appear here."
        />
      </>
    )
  }

  return (
    <>
      <Head />
      {runs.data.runs.map((run) => (
        <div
          key={`${run.repo}#${run.issue}`}
          className="mb-1.5 flex items-center gap-3 rounded-xl border border-border bg-card p-3"
        >
          <span
            className={`size-[7px] shrink-0 rounded-full ${DOT[run.status] ?? 'bg-muted-foreground'}`}
          />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[13px]">
              {run.repo}#{run.issue}
            </div>
            <div className="font-mono text-[11.5px] text-muted-foreground">
              {run.status}
              {run.branch ? ` · ${run.branch}` : ''}
            </div>
          </div>
          {run.pr_url ? (
            <button
              type="button"
              onClick={() => void openUrl(run.pr_url as string)}
              className="text-[12px] text-primary hover:underline"
            >
              pull request
            </button>
          ) : null}
        </div>
      ))}
    </>
  )
}

function Head() {
  return (
    <>
      <h1 className="font-heading font-semibold text-[19px] tracking-tight">
        Runs
      </h1>
      <p className="mb-5 text-[13px] text-muted-foreground">
        Everything the factory has done.
      </p>
    </>
  )
}
