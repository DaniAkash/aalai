import { Link, useParams } from '@tanstack/react-router'
import { revisedNote, subjectOf, waitedFor } from 'aalai/shared'
import { Screen } from '@/components/layout/Screen'
import { ErrorNote, Loading } from '@/components/state'
import { useAnswerGate, useGate } from '@/modules/api/gates.hooks'
import { useReply, useThread } from '@/modules/api/thread.hooks'
import type { Decision } from './gate-detail.components'
import { Decide, Discussion } from './gate-sections.components'

/**
 * One gate: what is being asked, and the decision.
 *
 * The artifact is the point of the screen. Approving a plan without reading it
 * is the failure this gate exists to prevent, so the plan is the body of the
 * page and the decision sits under it rather than above.
 */
/** What this gate is called on screen. */
function titleFor(kind: string): string {
  switch (kind) {
    case 'plan':
      return 'Plan approval'
    case 'triage':
      return 'Worth doing?'
    default:
      return 'Permission'
  }
}

/** "just now" already reads as a time; everything else needs the "ago". */
function openedAgo(openedAt: string): string {
  const waited = waitedFor(openedAt)
  return waited === 'just now' ? waited : `${waited} ago`
}

export function GateDetail() {
  const { gateId } = useParams({ from: '/gates/$gateId' })
  const gate = useGate({ variables: { id: gateId } })
  const thread = useThread({ variables: { id: gateId } })
  const answer = useAnswerGate()
  const reply = useReply()

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
      title={titleFor(row.kind)}
      sub={[
        subjectOf(row.runId),
        `opened ${openedAgo(row.openedAt)}`,
        revisedNote(row.artifactVersion),
      ]
        .filter((part) => part !== '')
        .join(' · ')}
      actions={
        <Link
          to="/"
          className="inline-flex min-h-11 shrink-0 items-center text-[12px] text-muted-foreground hover:underline lg:min-h-0"
        >
          back to inbox
        </Link>
      }
    >
      {/*
        Side by side once there is room for both to be readable, stacked below
        that. The plan stays first in the document either way: approving without
        reading it is the failure this gate exists to prevent, and a discussion
        above it would invite exactly that.

        Each column scrolls itself rather than the page, so the decision stays
        reachable without scrolling past a long conversation to find it.
      */}
      <div className="mb-4 flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        {artifact === null ? null : (
          <article className="min-h-32 flex-1 overflow-y-auto rounded-xl border border-border bg-card p-4 lg:basis-1/2">
            {/*
              Capped by measure rather than pixels, so it holds at every width.
              Uncapped this rendered 122 characters per line at 1280 and 143 at
              1440, against a readable maximum of about 75.
            */}
            <pre className="max-w-[80ch] whitespace-pre-wrap font-mono text-[13.5px] leading-relaxed">
              {artifact}
            </pre>
          </article>
        )}

        <Discussion
          gateOpen={row.status === 'open'}
          kind={row.kind}
          onSend={(body) =>
            reply.mutate({ id: gateId, body, author: 'maintainer' })
          }
          reply={reply}
          thread={thread}
        />
      </div>

      <Decide
        artifact={artifact}
        error={answer.error?.message}
        onDecide={decide}
        pending={answer.isPending}
        row={row}
      />
    </Screen>
  )
}
