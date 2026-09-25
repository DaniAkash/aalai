import { Link, useParams } from '@tanstack/react-router'
import { subjectOf } from 'aalai/shared'
import { Screen } from '@/components/layout/Screen'
import { Empty, ErrorNote, Loading } from '@/components/state'
import { useRunEvents } from '@/modules/api/runs.hooks'
import { Belt, Criteria, EventLog } from './run-detail.components'
import {
  criteriaOf,
  outcomeOf,
  stationStates,
  verdictOf,
} from './run-detail.helpers'

/**
 * One run, as it said it happened.
 *
 * Built from the event log rather than a stored summary, because a run that is
 * still working has no summary yet and the interesting case is watching it.
 */
export function RunDetail() {
  const { runId } = useParams({ from: '/runs/$runId' })
  const live = useRunEvents({ variables: { runId } })

  if (live.isPending) {
    return (
      <Screen title="Run">
        <Loading />
      </Screen>
    )
  }

  if (live.isError) {
    return (
      <Screen title="Run">
        <ErrorNote
          message={live.error.message}
          onRetry={() => live.refetch()}
        />
      </Screen>
    )
  }

  const events = live.data.events
  const verdict = verdictOf(events)

  return (
    <Screen
      title={subjectOf(runId)}
      sub={outcomeOf(events)}
      actions={
        <Link
          to="/runs"
          className="shrink-0 text-[12px] text-muted-foreground hover:underline"
        >
          all runs
        </Link>
      }
    >
      {events.length === 0 ? (
        <Empty
          title="Nothing recorded for this run"
          detail="The factory keeps what a run said in memory while it works. A run from before the last restart has only its outcome, on the runs list."
        />
      ) : (
        <>
          <Belt states={stationStates(events)} />
          <Criteria
            criteria={criteriaOf(events)}
            results={verdict?.results ?? []}
          />
          <EventLog events={events} />
        </>
      )}
    </Screen>
  )
}
