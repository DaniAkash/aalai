import {
  type TrustFacts,
  trustConsequence,
  trustLabel,
  trustReason,
} from 'aalai/shared'
import { useState } from 'react'
import { Button } from '@/components/ui/button'

export type TrustDecision = 'approved' | 'rejected'

/**
 * The decision about running code somebody else wrote.
 *
 * Its own panel rather than the shared one, and not for tidiness. The shared
 * panel offers three actions including asking for changes, and a trust gate
 * accepts two: there is nothing to send back, because the review has already
 * said everything it can without running anything. Showing the third would offer
 * an action that comes back as an error.
 *
 * Everything else a gate has asked could be undone. This one runs somebody
 * else's code on the machine of the person reading it, and nothing undoes that,
 * so the sentence above the button says that in those words and the button does
 * not say approve.
 */
export function TrustDecisionPanel({
  facts,
  pending,
  error,
  onDecide,
}: {
  facts: TrustFacts
  pending: boolean
  error: string | undefined
  onDecide: (decision: TrustDecision, reason: string) => void
}) {
  const [reason, setReason] = useState('')

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p
        className="mb-1 font-medium text-[14px]"
        data-testid="trust-consequence"
      >
        {trustConsequence()}
      </p>
      <p className="mb-3 text-[12.5px] text-muted-foreground">
        {trustReason(facts)}
      </p>

      <label className="sr-only" htmlFor="trust-reason">
        Why, if you are declining
      </label>
      <textarea
        className="mb-3 h-16 w-full resize-none rounded-xl border border-border bg-background p-3 text-[14px] outline-none focus:border-ring"
        id="trust-reason"
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why, if you are declining. This travels with the decision."
        value={reason}
      />

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
          {trustLabel()}
        </Button>
        <Button
          className="min-h-11 min-w-11 text-destructive lg:min-h-9"
          disabled={pending}
          onClick={() => onDecide('rejected', reason.trim())}
          size="sm"
          variant="ghost"
        >
          Do not run it
        </Button>
      </div>
    </div>
  )
}
