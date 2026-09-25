import { Link, useParams } from '@tanstack/react-router'
import { subjectOf, waitedFor } from 'aalai/shared'
import { Screen } from '@/components/layout/Screen'
import { ErrorNote, Loading } from '@/components/state'
import { useAnswerGate, useGate } from '@/modules/api/gates.hooks'
import {
  Answered,
  type Decision,
  DecisionPanel,
} from './gate-detail.components'

/**
 * One gate: what is being asked, and the decision.
 *
 * The artifact is the point of the screen. Approving a plan without reading it
 * is the failure this gate exists to prevent, so the plan is the body of the
 * page and the decision sits under it rather than above.
 */
/** "just now" already reads as a time; everything else needs the "ago". */
function openedAgo(openedAt: string): string {
  const waited = waitedFor(openedAt)
  return waited === 'just now' ? waited : `${waited} ago`
}

export function GateDetail() {
  const { gateId } = useParams({ from: '/gates/$gateId' })
  const gate = useGate({ variables: { id: gateId } })
  const answer = useAnswerGate()

  if (gate.isPending) {
    return (
      <Screen title="Gate">
        <Loading />
      </Screen>
    )
  }

  if (gate.isError) {
    return (
      <Screen title="Gate">
        <ErrorNote
          message={gate.error.message}
          onRetry={() => gate.refetch()}
        />
      </Screen>
    )
  }

  const { gate: row, artifact } = gate.data

  const decide = (decision: Decision, reason: string) => {
    answer.mutate({
      id: gateId,
      decision,
      ...(reason === '' ? {} : { reason }),
      answeredBy: 'maintainer',
    })
  }

  return (
    <Screen
      title={row.kind === 'plan' ? 'Plan approval' : 'Permission'}
      sub={`${subjectOf(row.runId)} · opened ${openedAgo(row.openedAt)}`}
      actions={
        <Link
          to="/"
          className="shrink-0 text-[12px] text-muted-foreground hover:underline"
        >
          back to inbox
        </Link>
      }
    >
      {artifact === null ? null : (
        <article className="mb-4 max-h-[46vh] overflow-y-auto rounded-xl border border-border bg-card p-4">
          <pre className="whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed">
            {artifact}
          </pre>
        </article>
      )}

      {row.status === 'open' ? (
        <DecisionPanel
          gate={row}
          pending={answer.isPending}
          error={answer.error?.message}
          onDecide={decide}
        />
      ) : (
        <Answered gate={row} />
      )}
    </Screen>
  )
}
