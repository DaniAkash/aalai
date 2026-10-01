import type { RunStatus } from 'aalai/shared'
import { capacityLine, emptyQueueCopy, STATUS_TABS } from 'aalai/shared'
import { useState } from 'react'
import { Screen } from '@/components/layout/Screen'
import { Empty, ErrorNote, Loading } from '@/components/state'
import {
  type QueueEntry,
  useDismissRun,
  usePauseQueue,
  useQueue,
  useQueueRun,
  useStartRun,
} from '@/modules/api/queue.hooks'
import {
  CapacityMeter,
  QueueRow,
  RowButton,
  StatusTabs,
} from './queue.components'

/**
 * Everything the factory has been asked to do, and how much of the machine it
 * may use doing it.
 *
 * The capacity meter is first because it is the screen's argument: this runs on
 * a laptop, so the number of things happening at once is small, visible, and
 * yours.
 */
export function Queue() {
  const [tab, setTab] = useState<RunStatus | 'all'>('all')
  const queue = useQueue()
  const start = useStartRun()
  const queueIt = useQueueRun()
  const dismiss = useDismissRun()
  const pause = usePauseQueue()

  if (queue.isPending) {
    return (
      <Screen title="Queue">
        <Loading rows={4} />
      </Screen>
    )
  }

  if (queue.isError) {
    return (
      <Screen title="Queue">
        <ErrorNote
          message={queue.error.message}
          onRetry={() => queue.refetch()}
        />
      </Screen>
    )
  }

  const { entries, running, capacity, paused } = queue.data
  // Offers belong to the inbox. Showing them here would make the queue look
  // full of work nobody asked for, which is the impression this screen exists
  // to undo.
  const inQueue = entries.filter((e) => e.status !== 'offered')
  const counts = countByStatus(inQueue)
  const shown =
    tab === 'all' ? inQueue : inQueue.filter((e) => e.status === tab)
  const queued = counts.queued ?? 0

  let position = 0

  return (
    <Screen title="Queue" sub="Nothing starts until you ask for it.">
      <section className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3.5">
        <CapacityMeter running={running} capacity={capacity} />
        <div className="min-w-0">
          <div
            className="font-semibold text-[13.5px]"
            data-testid="capacity-head"
          >
            {running} of {capacity} {capacity === 1 ? 'slot' : 'slots'} busy
          </div>
          <div
            className="text-[12px] text-muted-foreground"
            data-testid="capacity-sub"
          >
            {capacityLine({ running, capacity, queued, paused })}
          </div>
        </div>
        <div className="ml-auto">
          <RowButton
            testId="pause-queue"
            onClick={() => pause.mutate({ paused: !paused })}
          >
            {paused ? 'Resume the queue' : 'Pause the queue'}
          </RowButton>
        </div>
      </section>

      <StatusTabs
        tabs={STATUS_TABS}
        value={tab}
        counts={{ ...counts, all: inQueue.length }}
        onChange={setTab}
      />

      {shown.length === 0 ? (
        <Empty title="Nothing here" detail={emptyQueueCopy(tab)} />
      ) : (
        <div className="flex flex-col gap-1.5">
          {shown.map((entry) => {
            if (entry.status === 'queued') {
              position += 1
            }
            return (
              <QueueRow
                key={`${entry.repo}:${entry.kind}:${entry.number}`}
                entry={entry}
                position={entry.status === 'queued' ? position : null}
                actions={
                  <Actions
                    entry={entry}
                    full={running >= capacity}
                    onStart={() => start.mutate(subjectOf(entry))}
                    onQueue={() => queueIt.mutate(subjectOf(entry))}
                    onDismiss={() => dismiss.mutate(subjectOf(entry))}
                  />
                }
              />
            )
          })}
        </div>
      )}
    </Screen>
  )
}

function Actions({
  entry,
  full,
  onStart,
  onQueue,
  onDismiss,
}: {
  entry: QueueEntry
  full: boolean
  onStart: () => void
  onQueue: () => void
  onDismiss: () => void
}) {
  if (entry.status === 'queued') {
    return (
      <>
        <RowButton primary disabled={full} onClick={onStart} testId="start-now">
          Start now
        </RowButton>
        <RowButton onClick={onDismiss} testId="remove">
          Remove
        </RowButton>
      </>
    )
  }
  if (entry.status === 'stopped' || entry.status === 'failed') {
    return (
      <RowButton primary onClick={onQueue} testId="queue-again">
        {entry.status === 'failed' ? 'Try again' : 'Queue again'}
      </RowButton>
    )
  }
  return null
}

function subjectOf(entry: QueueEntry) {
  return { repo: entry.repo, kind: entry.kind, number: entry.number }
}

function countByStatus(entries: readonly QueueEntry[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of entries) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1
  }
  return counts
}
