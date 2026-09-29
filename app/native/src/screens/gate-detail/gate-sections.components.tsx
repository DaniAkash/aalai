import type { GateRow } from 'aalai/shared'
import { ErrorNote, Loading } from '@/components/state'
import {
  Answered,
  type Decision,
  DecisionPanel,
} from './gate-detail.components'
import { Composer, Thread, type ThreadEntry } from './gate-thread.components'
import { TriageDecisionPanel } from './triage-report.components'
import { factsFromReport } from './triage-report.helpers'

/**
 * Who the words on this screen are about.
 *
 * A triage gate and a plan gate ask different questions of different stations,
 * and the difference is only ever these two words, so they are named once
 * rather than branched on everywhere they appear.
 */
function voiceOf(kind: string): { subject: string; station: string } {
  return kind === 'triage'
    ? { subject: 'the report', station: 'the classifier' }
    : { subject: 'the plan', station: 'the analyst' }
}

export function Discussion({
  kind,
  gateOpen,
  thread,
  reply,
  onSend,
}: {
  kind: string
  gateOpen: boolean
  thread: {
    isPending: boolean
    isError: boolean
    error: Error | null
    data: { state: string; entries: readonly ThreadEntry[] } | undefined
    refetch: () => void
  }
  reply: {
    isPending: boolean
    isSuccess: boolean
    submittedAt: number
    error: Error | null
  }
  onSend: (body: string) => void
}) {
  const voice = voiceOf(kind)
  return (
    <section
      aria-label="Discussion"
      className="flex min-h-0 flex-col gap-3 lg:basis-1/2"
    >
      <h2 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-wide">
        Discussion
      </h2>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {thread.isPending ? (
          <Loading rows={2} />
        ) : thread.isError ? (
          <ErrorNote
            message={thread.error?.message ?? ''}
            onRetry={() => thread.refetch()}
          />
        ) : (
          <Thread
            answering={thread.data?.state === 'answering'}
            entries={thread.data?.entries ?? []}
            subject={voice.subject}
          />
        )}
      </div>
      {/*
        Rendered whatever the gate's status, because the composer keeps the
        draft when the gate is answered from somewhere else. It returns null
        itself once there is nothing left to keep.
      */}
      <Composer
        answering={thread.data?.state === 'answering'}
        error={reply.error?.message}
        gateOpen={gateOpen}
        onSend={onSend}
        pending={reply.isPending}
        sentAt={reply.isSuccess ? reply.submittedAt : 0}
        station={voice.station}
      />
    </section>
  )
}

/** The decision to make, or the record of one already made. */
export function Decide({
  row,
  artifact,
  pending,
  error,
  onDecide,
}: {
  row: GateRow
  artifact: string | null
  pending: boolean
  error: string | undefined
  onDecide: (decision: Decision, reason: string) => void
}) {
  if (row.status !== 'open') {
    return <Answered gate={row} />
  }
  if (row.kind === 'triage') {
    return (
      <TriageDecisionPanel
        error={error}
        facts={factsFromReport(artifact)}
        onDecide={onDecide}
        pending={pending}
      />
    )
  }
  return (
    <DecisionPanel
      error={error}
      gate={row}
      onDecide={onDecide}
      pending={pending}
    />
  )
}
