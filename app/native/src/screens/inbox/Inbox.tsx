import { Link } from '@tanstack/react-router'
import { subjectOf, waitedFor } from 'aalai-core/shared'
import { GroupHead, Screen } from '@/components/layout/Screen'
import { Empty, ErrorNote, Loading } from '@/components/state'
import { useInboxData } from './inbox.data'
import { asking } from './inbox.helpers'

/**
 * What needs a person, in the order it needs them.
 *
 * The home surface is not throughput. The maintainer's job is answering gates,
 * so the first thing on screen is what is waiting, oldest first, because the
 * thing that has waited longest is the thing most likely to be blocking
 * somebody.
 */
export function Inbox() {
  const { gates, working, isPending, isError, error, retry } = useInboxData()

  if (isPending) {
    return (
      <Screen title="Inbox">
        <Loading />
      </Screen>
    )
  }

  if (isError) {
    return (
      <Screen title="Inbox">
        <ErrorNote message={error} onRetry={retry} />
      </Screen>
    )
  }

  if (gates.length === 0) {
    return (
      <Screen title="Inbox" sub="Nothing is waiting on you.">
        <Empty
          title="Nothing is waiting on you"
          detail={
            working === 0
              ? 'The factory is watching and will raise a gate here when it needs a decision.'
              : `${working} ${working === 1 ? 'run is' : 'runs are'} in flight. Nothing needs you yet.`
          }
        />
      </Screen>
    )
  }

  return (
    <Screen
      title="Inbox"
      sub={`${gates.length} waiting on you. Nothing moves until you answer.`}
    >
      <GroupHead label="Waiting on you" count={gates.length} />
      {gates.map((gate) => (
        <Link
          key={gate.id}
          to="/gates/$gateId"
          params={{ gateId: gate.id }}
          className="mb-1.5 flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:border-ring"
        >
          <span className="size-[7px] shrink-0 rounded-full bg-chart-4" />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[11.5px] text-muted-foreground">
              {subjectOf(gate.runId)}
            </div>
            <div className="mt-0.5 truncate text-[13.5px]">{asking(gate)}</div>
          </div>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {waitedFor(gate.openedAt)}
          </span>
        </Link>
      ))}
    </Screen>
  )
}
