import type { StepActivity, SubjectActivity, Turn } from 'aalai/shared'
import { ApprovalCard } from '@/components/agents/approval-card'
import type { Awaiting } from '@/modules/api/workDetail.hooks'

import { LiveStep } from './live.components'
import { Recorded, Said, SystemNote } from './work-detail.components'

/**
 * The thread itself: what has happened, what is happening, what is wanted.
 *
 * Split from the screen because the screen's job is to resolve the data and
 * this one's is to lay it out, and together they were one function with
 * twenty branches.
 */

export interface ThreadProps {
  turns: readonly Turn[]
  activity: SubjectActivity
  steps: readonly string[]
  /** Which artifact's body is open, and how to open another. */
  open: string | null
  onOpen: (artifact: string) => void
  openBody?: string
  /** The artifact id of the plan in force, which is the one that ticks off. */
  planArtifact?: string
}

export function Thread({
  turns,
  activity,
  steps,
  open,
  onOpen,
  openBody,
  planArtifact,
}: ThreadProps) {
  return (
    <>
      {turns.length === 0 && activity.live === null ? (
        // Suppressed while a station is working: a run can reach its first
        // step before it has written anything, and "nothing has happened yet"
        // directly above a visible live step reads as a bug.
        <p className="rounded-[var(--radius)] border border-border border-dashed bg-sidebar px-4 py-10 text-center text-[13px] text-muted-foreground">
          Nothing has happened yet. When a station reads the repository and
          writes a plan, it appears here.
        </p>
      ) : null}

      {turns.map((turn) => (
        <TurnRow
          key={turn.id}
          turn={turn}
          activity={activity}
          steps={steps}
          open={open}
          onOpen={onOpen}
          openBody={openBody}
          planArtifact={planArtifact}
        />
      ))}

      {activity.live === null ? null : (
        <LiveStep live={activity.live} title={titleOf(steps, activity.live)} />
      )}
    </>
  )
}

/**
 * What to call the running step.
 *
 * The plan in force wins, because that is the wording a person agreed to. What
 * the station called it comes next, for a step beyond the plan or before one
 * has been recorded. The number is the last resort.
 */
function titleOf(steps: readonly string[], live: StepActivity): string {
  return steps[live.stepIndex] ?? live.label ?? `Step ${live.stepIndex + 1}`
}

function TurnRow({
  turn,
  activity,
  steps,
  open,
  onOpen,
  openBody,
  planArtifact,
}: { turn: Turn } & Omit<ThreadProps, 'turns'>) {
  if (turn.kind === 'said') {
    return <Said turn={turn} body={turn.body} />
  }
  if (turn.kind !== 'recorded') {
    return <SystemNote turn={turn} />
  }
  const active = open === turn.artifact
  return (
    <Recorded
      turn={turn}
      active={active}
      onOpen={() => onOpen(turn.artifact)}
      {...(active && openBody !== undefined ? { body: openBody } : {})}
      {...(planArtifact === turn.artifact ? planProps(activity, steps) : {})}
    />
  )
}

/** What the plan in force needs to tick itself off. */
function planProps(activity: SubjectActivity, steps: readonly string[]) {
  return {
    steps,
    finished: activity.finished,
    ...(activity.live === null
      ? {}
      : { runningIndex: activity.live.stepIndex }),
  }
}

/** The one decision in front of a person, when there is one. */
export function Awaits({
  awaiting,
  submitting,
  onAnswer,
}: {
  awaiting: NonNullable<Awaiting>
  submitting: boolean
  onAnswer: (decision: 'approved' | 'changes' | 'rejected') => void
}) {
  return (
    <ApprovalCard
      title={waitingTitle(awaiting)}
      description={awaiting.summary ?? undefined}
      status={submitting ? 'submitting' : 'pending'}
      approveLabel={approveLabel(awaiting)}
      onApprove={() => onAnswer('approved')}
      onRequestChanges={() => onAnswer('changes')}
      onReject={() => onAnswer('rejected')}
    />
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
