import {
  approvalConsequence,
  approvalLabel,
  CLASSIFICATIONS,
  classificationLine,
  readsAsQuestion,
  type TriageFacts,
} from 'aalai/shared'
import { useState } from 'react'
import { Button } from '@/components/ui/button'

export type TriageDecision = 'approved' | 'rejected' | 'reclassify'

/**
 * What the classifier decided, and what saying yes to it will do.
 *
 * The consequence line above the buttons is the most important thing on this
 * screen. Approving here can post a comment under the maintainer's name on a
 * public repository, and the word "approve" does not distinguish that from
 * starting a run that posts nothing. It is stated before the click rather than
 * discovered after it.
 */
export function TriageDecisionPanel({
  facts,
  pending,
  error,
  onDecide,
}: {
  facts: TriageFacts
  pending: boolean
  error: string | undefined
  onDecide: (decision: TriageDecision, reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const [correcting, setCorrecting] = useState(false)

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="mb-1 flex flex-wrap items-center gap-2 text-[14px]">
        <span className="font-medium">{classificationLine(facts)}</span>
        <span className="rounded border border-border px-1 text-[11px] text-muted-foreground uppercase tracking-wide">
          {facts.confidence} confidence
        </span>
      </p>

      {readsAsQuestion(facts) ? (
        <p className="mb-3 text-[12.5px] text-muted-foreground">
          The classifier was not sure. Treat this as a question rather than as a
          proposal.
        </p>
      ) : null}

      <label className="sr-only" htmlFor="triage-reason">
        Why, if you are rejecting or correcting this
      </label>
      <textarea
        className="mb-3 h-16 w-full resize-none rounded-xl border border-border bg-background p-3 text-[14px] outline-none focus:border-ring"
        id="triage-reason"
        onChange={(event) => setReason(event.target.value)}
        placeholder={
          correcting
            ? 'What is it actually? This is what the classifier reads next.'
            : 'Why, if you are rejecting. This travels with the decision.'
        }
        value={reason}
      />

      {correcting ? (
        <div
          className="mb-3 flex flex-wrap gap-1.5"
          data-testid="reclassify-to"
        >
          {CLASSIFICATIONS.filter((name) => name !== facts.classification).map(
            (name) => (
              <Button
                className="min-h-11 min-w-11 lg:min-h-9"
                disabled={pending}
                key={name}
                onClick={() =>
                  onDecide(
                    'reclassify',
                    reason.trim() === ''
                      ? `This is a ${name}.`
                      : `This is a ${name}. ${reason.trim()}`,
                  )
                }
                size="sm"
                variant="outline"
              >
                {name}
              </Button>
            ),
          )}
        </div>
      ) : null}

      {/*
        Said before the click, not after. This is the only thing on the screen
        that distinguishes a decision which posts publicly from one that does
        not.
      */}
      <p
        className="mb-3 text-[12.5px] text-muted-foreground"
        data-testid="approval-consequence"
      >
        {approvalConsequence(facts)}
      </p>

      {error === undefined ? null : (
        <p className="mb-3 text-[12.5px] text-destructive">{error}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          className="min-h-11 min-w-11 lg:min-h-9"
          disabled={pending}
          onClick={() => onDecide('approved', reason.trim())}
          size="sm"
        >
          {approvalLabel(facts)}
        </Button>
        <Button
          className="min-h-11 min-w-11 lg:min-h-9"
          disabled={pending}
          onClick={() => setCorrecting((was) => !was)}
          size="sm"
          variant="outline"
        >
          {correcting ? 'Cancel' : 'Reclassify'}
        </Button>
        <Button
          className="min-h-11 min-w-11 text-destructive lg:min-h-9"
          disabled={pending}
          onClick={() => onDecide('rejected', reason.trim())}
          size="sm"
          variant="ghost"
        >
          Reject
        </Button>
      </div>
    </div>
  )
}
