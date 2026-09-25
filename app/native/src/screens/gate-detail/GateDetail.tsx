import { Link, useParams } from '@tanstack/react-router'
import { subjectOf, waitedFor } from 'aalai-core/shared'
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
          className="inline-flex min-h-11 shrink-0 items-center text-[12px] text-muted-foreground hover:underline md:min-h-0"
        >
          back to inbox
        </Link>
      }
    >
      {/*
        The artifact is sized by what is left rather than by a share of the
        viewport. The old 46vh cap could not see the header, textarea and
        decision card below it, so at 1024 it hid six pixels behind a scrollbar
        while 120px sat empty, and at 768 it hid a fifth of the plan.
      */}
      {artifact === null ? null : (
        <article className="mb-4 min-h-32 flex-1 overflow-y-auto rounded-xl border border-border bg-card p-4">
          {/*
            Capped by measure rather than pixels, so it holds at every width.
            Uncapped this rendered 122 characters per line at 1280 and 143 at
            1440, against a readable maximum of about 75.
          */}
          <pre className="max-w-[80ch] whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed">
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
