import { GroupHead } from '@/components/layout/Screen'
import type { QueueEntry } from '@/modules/api/queue.hooks'
import { useDismissRun, useQueueRun } from '@/modules/api/queue.hooks'

/**
 * What the factory found, waiting on a decision.
 *
 * Each row says that nothing has started, because that is the fact the whole
 * queue turns on: seeing something costs one API call, and running it costs a
 * coding agent and a checkout on a laptop somebody is also using.
 */
export function Offers({ offers }: { offers: readonly QueueEntry[] }) {
  const queueIt = useQueueRun()
  const dismiss = useDismissRun()

  if (offers.length === 0) {
    return null
  }

  return (
    <section data-testid="offers">
      <GroupHead label="New, waiting on your call" count={offers.length} />
      {offers.map((offer) => {
        const subject = {
          repo: offer.repo,
          kind: offer.kind,
          number: offer.number,
        }
        return (
          <div
            key={`${offer.repo}:${offer.kind}:${offer.number}`}
            data-testid="offer-row"
            className="mb-1.5 flex flex-col items-stretch gap-2 rounded-xl border border-border bg-card p-3 md:flex-row md:items-center md:gap-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
                <span>{offer.repo}</span>
                <span>
                  {offer.kind === 'pr' ? 'PR' : 'issue'} #{offer.number}
                </span>
              </div>
              <div className="mt-0.5 truncate text-[14px]">
                {offer.title ?? `${offer.kind} #${offer.number}`}
              </div>
              <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                Nothing has started.
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                data-testid="queue-it"
                onClick={() => queueIt.mutate(subject)}
                className="min-h-9 rounded-lg bg-primary px-3 font-semibold text-[12.5px] text-primary-foreground hover:opacity-90"
              >
                Queue it
              </button>
              <button
                type="button"
                data-testid="not-now"
                onClick={() => dismiss.mutate(subject)}
                className="min-h-9 rounded-lg border border-border px-3 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Not now
              </button>
            </div>
          </div>
        )
      })}
    </section>
  )
}
