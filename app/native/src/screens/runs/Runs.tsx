import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Empty, ErrorNote, Loading } from '@/components/state'
import { useActiveRuns, usePastRuns } from '@/modules/api/runs.hooks'
import { openExternal } from '@/modules/host/open-external'

// Keyed on the statuses the core actually emits.
const DOT: Record<string, string> = {
  claimed: 'bg-primary',
  delivered: 'bg-chart-2',
  failed: 'bg-destructive',
  skipped: 'bg-muted-foreground',
}

export function Runs() {
  const runs = usePastRuns()
  const active = useActiveRuns()

  const runIdFor = (run: { repo: string; issue: number }): string | undefined =>
    active.data?.runs.find((row) =>
      row.runId.startsWith(`${run.repo}#${run.issue}@`),
    )?.runId

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
        <Row key={`${run.repo}#${run.issue}`} runId={runIdFor(run)}>
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
              onClick={() => void openExternal(run.pr_url as string)}
              className="text-[12px] text-primary hover:underline"
            >
              pull request
            </button>
          ) : null}
        </Row>
      ))}
    </>
  )
}

/**
 * A row that leads somewhere only when there is somewhere to lead.
 *
 * Events live in memory, so a run from before the last restart has none. A
 * link to an empty page is worse than no link.
 */
function Row({
  runId,
  children,
}: {
  runId: string | undefined
  children: ReactNode
}) {
  const shape =
    'mb-1.5 flex items-center gap-3 rounded-xl border border-border bg-card p-3'
  if (runId === undefined) {
    return <div className={shape}>{children}</div>
  }
  return (
    <Link
      to="/runs/$runId"
      params={{ runId }}
      className={`${shape} transition-colors hover:border-ring`}
    >
      {children}
    </Link>
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
