import type { GateRow } from 'aalai-core/shared'
import { useState } from 'react'
import { ApprovalCard } from '@/components/agents/approval-card'

export type Decision = 'approved' | 'rejected' | 'changes'

/**
 * The decision, and the reason that travels with it.
 *
 * The reason is a field rather than a prompt after the fact, because rejecting
 * without one produces an issue comment nobody can act on, and asking for it
 * afterwards is a second dialog to dismiss.
 */
export function DecisionPanel({
  gate,
  pending,
  error,
  onDecide,
}: {
  gate: GateRow
  pending: boolean
  error: string | undefined
  onDecide: (decision: Decision, reason: string) => void
}) {
  const [reason, setReason] = useState('')

  return (
    <>
      <textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why, if you are rejecting or asking for changes. This travels with the decision."
        className="mb-3 h-20 w-full resize-none rounded-xl border border-border bg-card p-3 text-[13px] outline-none focus:border-ring"
      />
      <ApprovalCard
        title={
          gate.summary ??
          `Approve this plan${gate.artifactVersion === null ? '' : ` (v${gate.artifactVersion})`}?`
        }
        description="Approving lets the run carry on. Asking for changes sends it back to the analyst at a new version."
        status={pending ? 'submitting' : 'pending'}
        approveLabel="Approve"
        onApprove={() => onDecide('approved', reason)}
        onRequestChanges={() => onDecide('changes', reason)}
        onReject={() => onDecide('rejected', reason)}
      />
      {error === undefined ? null : (
        <p className="mt-3 text-[12.5px] text-destructive">{error}</p>
      )}
    </>
  )
}

const SETTLED: Record<string, string> = {
  answered: 'This was answered',
  superseded: 'The plan changed under this gate',
  expired: 'This question expired',
}

const EXPLAINS: Record<string, string> = {
  superseded:
    'A newer version of the plan now stands, so the approval this asked for no longer applies. The current one is in the inbox.',
  expired:
    'A permission request only stands while the agent turn that raised it is open. That turn has ended, so the station fell back to its configured permission mode.',
}

/**
 * What happened, for a gate nobody can answer any more.
 *
 * Replacing the actions rather than disabling them, because a gate answered on
 * another surface is an ordinary event here: three of them can answer, and a
 * disabled button invites a person to wonder what they did wrong.
 */
export function Answered({ gate }: { gate: GateRow }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="font-medium text-[13.5px]">
        {SETTLED[gate.status] ?? 'This is settled'}
      </div>
      {gate.decision === null ? null : (
        <div className="mt-1 text-[13px] text-muted-foreground">
          {gate.decision} by {gate.answeredBy ?? 'someone'}
          {gate.answeredOn === null ? null : ` from the ${gate.answeredOn}`}
        </div>
      )}
      {gate.reason === null || gate.reason === '' ? null : (
        <p className="mt-2 border-border border-l-2 pl-3 text-[13px] text-muted-foreground">
          {gate.reason}
        </p>
      )}
      {EXPLAINS[gate.status] === undefined ? null : (
        <p className="mt-2 text-[12.5px] text-muted-foreground">
          {EXPLAINS[gate.status]}
        </p>
      )}
    </div>
  )
}
