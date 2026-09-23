import { createFileRoute } from '@tanstack/react-router'
import { Empty, ErrorNote, Loading } from '@/components/state'
import { usePastRuns } from '@/modules/api/runs.hooks'

export const Route = createFileRoute('/')({ component: InboxRoute })

/**
 * The inbox, which is the home surface rather than a dashboard.
 *
 * The maintainer's job is answering gates, so the first thing on screen is
 * what is waiting on them, not how much the factory has produced.
 */
function InboxRoute() {
  const runs = usePastRuns()

  if (runs.isPending) return <Screen title="Inbox"><Loading /></Screen>
  if (runs.isError) {
    return (
      <Screen title="Inbox">
        <ErrorNote message={runs.error.message} onRetry={() => runs.refetch()} />
      </Screen>
    )
  }

  const waiting = runs.data.runs.filter((r) => r.status === 'running')

  if (waiting.length === 0) {
    return (
      <Screen title="Inbox" sub="Nothing is waiting on you.">
        <Empty
          title="Nothing is waiting on you"
          detail="The factory is watching and will raise a gate here when it needs a decision. You will get a notification too."
        />
      </Screen>
    )
  }

  return (
    <Screen title="Inbox" sub={`${waiting.length} waiting on you. Nothing moves until you answer.`}>
      <GroupHead label="Waiting on you" count={waiting.length} />
      {waiting.map((run) => (
        <div
          key={`${run.repo}#${run.issue}`}
          className="border-border bg-card mb-1.5 flex items-center gap-3 rounded-xl border p-3"
        >
          <span className="bg-chart-4 size-[7px] shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <div className="text-muted-foreground font-mono text-[11.5px]">
              {run.repo}#{run.issue}
            </div>
            <div className="mt-0.5 text-[13.5px]">{run.branch ?? 'preparing a workspace'}</div>
          </div>
        </div>
      ))}
    </Screen>
  )
}

function Screen({
  title,
  sub,
  children,
}: {
  title: string
  sub?: string
  children: React.ReactNode
}) {
  return (
    <>
      <h1 className="font-heading text-[19px] font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground mb-5 text-[13px]">{sub ?? ' '}</p>
      {children}
    </>
  )
}

function GroupHead({ label, count }: { label: string; count: number }) {
  return (
    <div className="text-muted-foreground mb-2 flex items-center gap-2 font-mono text-[10px] tracking-widest uppercase">
      {label} <span className="text-foreground">{count}</span>
    </div>
  )
}
