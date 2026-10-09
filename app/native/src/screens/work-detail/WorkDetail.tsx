import { planSteps } from 'aalai/shared'
import { SplitPane } from '@/components/layout/panes'
import { ErrorNote } from '@/components/state'
import { Skeleton } from '@/components/ui/skeleton'
import { ChangesPane } from './ChangesPane'
import { WorkingBanner } from './live.components'
import { Awaits, Thread } from './thread.components'
import { useWorkDetailScreen } from './work-detail.hooks'

/**
 * One piece of work, as the conversation that produced it.
 *
 * The thread is the record and the live parts sit inside it rather than beside
 * it: the running step appears where it will be read, and the plan above it
 * ticks its own steps off. Nothing here moves that is not a state change.
 */
export function WorkDetail() {
  const {
    workId,
    detail,
    activity,
    answer,
    path,
    open,
    artifactBody,
    slot,
    toggleArtifact,
    chooseFile,
  } = useWorkDetailScreen()

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

  const { item: work, awaiting } = detail.data
  // The gate a person is being asked to answer is rendered as the card at the
  // end, so it must not also appear as a note in the thread saying the same
  // thing a few lines above the control that acts on it.
  const turns = detail.data.turns.filter(
    (turn) => turn.kind !== 'gate' || turn.gateId !== awaiting?.gateId,
  )
  // The plan in force is what a step index counts against. Without one there
  // is nothing to name the running step, so it shows its number instead.
  const steps = detail.data.plan ? planSteps(detail.data.plan.body) : []

  return (
    <SplitPane
      aside={<ChangesPane workId={workId} path={path} onChoose={chooseFile} />}
    >
      {activity.live === null ? null : (
        <WorkingBanner station={activity.live.station} slot={slot} />
      )}
      <header className="border-border border-b px-4 py-4 md:px-6">
        <h1 className="font-heading font-semibold text-[17px] leading-snug tracking-tight">
          {work.title}
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted-foreground">
          <span className="font-mono text-[11.5px]">{work.repo}</span>
          <span aria-hidden>&middot;</span>
          <span className="font-mono text-[11.5px]">
            {work.kind} #{work.number}
          </span>
          {work.branch === null ? null : (
            <>
              <span aria-hidden>&middot;</span>
              <span className="font-mono text-[11.5px]">{work.branch}</span>
            </>
          )}
        </p>
      </header>

      <div className="flex flex-col gap-5 px-4 py-5 md:px-6">
        <Thread
          turns={turns}
          activity={activity}
          steps={steps}
          open={open}
          onOpen={toggleArtifact}
          {...(artifactBody === undefined ? {} : { openBody: artifactBody })}
          {...(detail.data.plan
            ? { planArtifact: detail.data.plan.artifact }
            : {})}
        />

        {awaiting === null ? null : (
          <Awaits
            awaiting={awaiting}
            submitting={answer.isPending}
            onAnswer={(decision) =>
              answer.mutate({
                id: awaiting.gateId,
                decision,
                answeredBy: 'you',
              })
            }
          />
        )}
      </div>
    </SplitPane>
  )
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
