import { useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { ApprovalCard } from '@/components/agents/approval-card'
import { useToast } from '@/components/providers/ToastProvider'
import { ErrorNote } from '@/components/state'
import { Skeleton } from '@/components/ui/skeleton'
import { useAnswerGate } from '@/modules/api/gates.hooks'
import { queryClient } from '@/modules/api/queryClient'
import { type Awaiting, useWorkDetail } from '@/modules/api/workDetail.hooks'
import { Recorded, Said, SystemNote } from './work-detail.components'

/**
 * One piece of work, as the conversation that produced it.
 *
 * Read only on purpose. The layout is the hardest thing in the design and it
 * is wrong whether or not it is animating, so it is built static first and the
 * live parts arrive once this is right.
 */
export function WorkDetail() {
  const { workId } = useParams({ from: '/_app/work/$workId' })
  const [open, setOpen] = useState<string | null>(null)
  const toast = useToast()
  const detail = useWorkDetail({ variables: { id: workId } })
  const answer = useAnswerGate({
    onError: (error) => toast.failed('Could not record that answer', error),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: useWorkDetail.getKey() })
    },
  })

  if (detail.isPending) {
    return <ThreadSkeleton />
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="px-4 py-5 md:px-6">
        <ErrorNote
          message={detail.error?.message ?? 'no response'}
          onRetry={() => detail.refetch()}
        />
      </div>
    )
  }

  const { item, awaiting } = detail.data
  // The gate a person is being asked to answer is rendered as the card at the
  // end, so it must not also appear as a note in the thread saying the same
  // thing a few lines above the control that acts on it.
  const turns = detail.data.turns.filter(
    (turn) => turn.kind !== 'gate' || turn.gateId !== awaiting?.gateId,
  )

  return (
    <div className="flex min-h-0 flex-col">
      <header className="border-border border-b px-4 py-4 md:px-6">
        <h1 className="font-heading font-semibold text-[17px] leading-snug tracking-tight">
          {item.title}
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted-foreground">
          <span className="font-mono text-[11.5px]">{item.repo}</span>
          <span aria-hidden>&middot;</span>
          <span className="font-mono text-[11.5px]">
            {item.kind} #{item.number}
          </span>
          {item.branch === null ? null : (
            <>
              <span aria-hidden>&middot;</span>
              <span className="font-mono text-[11.5px]">{item.branch}</span>
            </>
          )}
        </p>
      </header>

      <div className="flex flex-col gap-5 px-4 py-5 md:px-6">
        {turns.length === 0 ? (
          <p className="rounded-[var(--radius)] border border-border border-dashed bg-sidebar px-4 py-10 text-center text-[13px] text-muted-foreground">
            Nothing has happened yet. When a station reads the repository and
            writes a plan, it appears here.
          </p>
        ) : null}

        {turns.map((turn) =>
          turn.kind === 'said' ? (
            <Said key={turn.id} turn={turn} body={turn.body} />
          ) : turn.kind === 'recorded' ? (
            <Recorded
              key={turn.id}
              turn={turn}
              active={open === turn.artifact}
              onOpen={() => setOpen(turn.artifact)}
            />
          ) : (
            <SystemNote key={turn.id} turn={turn} />
          ),
        )}

        {awaiting === null ? null : (
          <ApprovalCard
            title={waitingTitle(awaiting)}
            description={awaiting.summary ?? undefined}
            status={answer.isPending ? 'submitting' : 'pending'}
            approveLabel={approveLabel(awaiting)}
            onApprove={() =>
              answer.mutate({
                id: awaiting.gateId,
                decision: 'approved',
                answeredBy: 'you',
              })
            }
            onRequestChanges={() =>
              answer.mutate({
                id: awaiting.gateId,
                decision: 'changes',
                answeredBy: 'you',
              })
            }
            onReject={() =>
              answer.mutate({
                id: awaiting.gateId,
                decision: 'rejected',
                answeredBy: 'you',
              })
            }
          />
        )}
      </div>
    </div>
  )
}

function waitingTitle(awaiting: NonNullable<Awaiting>): string {
  return awaiting.kind === 'plan' ? 'Approve this plan?' : 'Allow this?'
}

/**
 * The button names the version it approves.
 *
 * An approval is recorded against one version of one artifact, so a button
 * that says only "Approve" is a promise it cannot keep once a new version has
 * been written while the screen was open.
 */
function approveLabel(awaiting: NonNullable<Awaiting>): string {
  return awaiting.artifactVersion === null
    ? 'Allow it'
    : `Approve ${awaiting.kind} v${awaiting.artifactVersion}`
}

function ThreadSkeleton() {
  return (
    <div className="flex flex-col gap-5 px-4 py-5 md:px-6">
      <Skeleton className="h-5 w-[48%]" />
      <Skeleton className="h-16 w-[70%] self-end rounded-[var(--radius)]" />
      <Skeleton className="h-12 w-[62%] rounded-[var(--radius)]" />
      <Skeleton className="h-12 w-[55%] rounded-[var(--radius)]" />
    </div>
  )
}
