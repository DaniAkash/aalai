import { useNavigate } from '@tanstack/react-router'
import { LANE_COPY, type Lane as LaneKey } from 'aalai/shared'
import { useState } from 'react'
import { Screen } from '@/components/layout/Screen'
import { useToast } from '@/components/providers/ToastProvider'
import { ErrorNote } from '@/components/state'
import { useStartRun } from '@/modules/api/queue.hooks'
import { useWork, type WorkItem } from '@/modules/api/work.hooks'
import { Filters, Lane, RowSkeleton, WorkRow } from './work-list.components'
import {
  countFor,
  FILTERS,
  type FilterKey,
  lanesFor,
} from './work-list.helpers'

/**
 * Everything in play, as one list.
 *
 * The unit is the piece of work rather than the run, because a person
 * describing a feature and a poller finding an issue produce the same thing
 * and following it should not mean three screens.
 */
export function WorkList() {
  const [filter, setFilter] = useState<FilterKey>('all')
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const work = useWork({ variables: {} })
  const toast = useToast()
  const start = useStartRun({
    onError: (error) => toast.failed('Could not start that work', error),
  })
  const navigate = useNavigate()

  if (work.isPending) {
    return (
      <Screen title="Work" sub="Loading what the factory has.">
        <div className="flex flex-col gap-2">
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </div>
      </Screen>
    )
  }

  if (work.isError || !work.data) {
    return (
      <Screen title="Work">
        <ErrorNote
          message={work.error?.message ?? 'no response'}
          onRetry={() => work.refetch()}
        />
      </Screen>
    )
  }

  const { lanes, counts, total } = work.data
  const keep = lanesFor(filter)
  const shown = lanes.filter(
    (lane) =>
      (keep === null || keep.includes(lane.key)) &&
      (lane.items.length > 0 || keep !== null),
  )

  return (
    <Screen title="Work" sub={subtitle(work.data.running, work.data.capacity)}>
      <Filters
        value={filter}
        onSelect={(key) => setFilter(key as FilterKey)}
        options={FILTERS.map((option) => ({
          key: option.key,
          label: option.label,
          count: countFor(option.key, counts, total),
        }))}
      />

      {shown.length === 0 ? <NothingYet /> : null}

      {shown.map((lane) => (
        <Lane
          key={lane.key}
          lane={lane.key}
          count={lane.items.length}
          open={!closed.has(lane.key)}
          onToggle={() => setClosed(toggle(closed, lane.key))}
        >
          {lane.items.length === 0 ? (
            <p className="rounded-[var(--radius)] border border-border border-dashed bg-sidebar px-4 py-6 text-center text-[13px] text-muted-foreground">
              {LANE_COPY[lane.key].empty}
            </p>
          ) : (
            lane.items.map((item) => (
              <WorkRow
                key={item.id}
                item={item}
                onOpen={() => openWork(item, navigate)}
                {...startProps(item, start)}
              />
            ))
          )}
        </Lane>
      ))}
    </Screen>
  )
}

/**
 * A row that has never run gets a Start button, and nothing else does.
 *
 * This is the queue made visible: aalai finds work on GitHub and does nothing
 * with it until a person says so.
 */
function startProps(
  item: WorkItem,
  start: ReturnType<typeof useStartRun>,
): { onStart?: () => void; starting?: boolean } {
  if (item.lane !== 'offered') {
    return {}
  }
  const subject = { repo: item.repo, kind: item.kind, number: item.number }
  // Kind is part of the match because an issue and a pull request may share a
  // number in one repository, and without it starting either one puts both
  // rows into the pending state.
  const mine =
    start.variables?.repo === item.repo &&
    start.variables?.kind === item.kind &&
    start.variables?.number === item.number
  return {
    onStart: () => start.mutate(subject),
    starting: start.isPending && mine,
  }
}

/**
 * Where a row goes when it is opened.
 *
 * A row with a pull request opens it, which is the one destination that is
 * genuinely about this subject. Everything else lands on the run history,
 * which is the whole list rather than this row's own run: the projection
 * carries no run id, so there is nothing to select on. That is a placeholder
 * until the thread exists, and the thread is what this should open.
 */
function openWork(
  item: WorkItem,
  navigate: ReturnType<typeof useNavigate>,
): void {
  if (item.prUrl !== null) {
    window.open(item.prUrl, '_blank', 'noopener')
    return
  }
  void navigate({ to: '/runs' })
}

function subtitle(running: number, capacity: number): string {
  return running === 0
    ? `Nothing running. Up to ${capacity} at once on this machine.`
    : `${running} of ${capacity} slots busy on this machine.`
}

function NothingYet() {
  return (
    <div className="rounded-[var(--radius)] border border-border border-dashed bg-sidebar px-4 py-14 text-center">
      <p className="mx-auto max-w-[42ch] text-[13px] text-muted-foreground">
        Add a repository and aalai will watch it. Issues and pull requests it
        finds appear here, and nothing runs until you start it.
      </p>
    </div>
  )
}

function toggle(set: ReadonlySet<string>, key: LaneKey): ReadonlySet<string> {
  const next = new Set(set)
  if (!next.delete(key)) {
    next.add(key)
  }
  return next
}
