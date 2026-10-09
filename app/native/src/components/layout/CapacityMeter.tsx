import { useAnimatedSidebar } from '@/components/motion/animated-sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useQueue } from '@/modules/api/queue.hooks'

/**
 * The hard limit on how much of this machine the factory may use, kept on
 * screen.
 *
 * aalai is a factory on a laptop a person is also working on, so the ceiling
 * is the product rather than a preference. It lives in the sidebar footer,
 * outside the scrolling region, because a person with thirty repositories
 * would otherwise never see it. Everything else in the sidebar can scroll
 * away; this cannot.
 */

/**
 * The highest ceiling the settings screen offers.
 *
 * Fixed rather than read from the response, so the meter has the same number
 * of segments at every setting and lowering the ceiling reads as slots being
 * switched off rather than the control shrinking.
 */
const MAX_SLOTS = 4

/** Stable keys, so a segment is not re-created when the ceiling changes. */
const SLOTS = Array.from({ length: MAX_SLOTS }, (_, i) => i)

export function CapacityMeter() {
  const queue = useQueue()
  const { state } = useAnimatedSidebar()
  const collapsed = state === 'collapsed'

  if (queue.isPending) {
    return <MeterSkeleton collapsed={collapsed} />
  }
  if (queue.isError || !queue.data) {
    return null
  }

  const { running, capacity, paused } = queue.data
  if (collapsed) {
    return (
      <div
        className="text-center font-mono text-[10px] text-muted-foreground"
        title={`${running} of ${capacity} running`}
      >
        {running}/{capacity}
      </div>
    )
  }

  return (
    <div className="rounded-[var(--radius)] border border-border bg-background p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="font-heading font-semibold text-[13px]">
          {running} of {capacity} running
        </span>
        <span className="text-[11px] text-muted-foreground">this laptop</span>
      </div>
      <Segments running={running} capacity={capacity} />
      <p className="mt-2 text-[11px] text-muted-foreground">
        {note(running, capacity, paused)}
      </p>
    </div>
  )
}

function Segments({
  running,
  capacity,
}: {
  running: number
  capacity: number
}) {
  return (
    <div className="flex gap-1">
      {SLOTS.map((slot) => (
        <span
          key={slot}
          className={cn(
            'h-1.5 flex-1 rounded-full border',
            slot >= capacity
              ? 'border-border bg-[repeating-linear-gradient(135deg,var(--secondary)_0_3px,transparent_3px_6px)]'
              : slot < running
                ? 'border-[var(--chart-2)] bg-[var(--chart-2)]'
                : 'border-border bg-secondary',
          )}
        />
      ))}
    </div>
  )
}

/**
 * What the current numbers mean, rather than what they are.
 *
 * The bar already says two of three. What a person cannot see from it is
 * whether the next thing they start waits, which is the only reason to look.
 */
function note(running: number, capacity: number, paused: boolean): string {
  // Checked before the free slots, because a free slot is not a promise that
  // anything starts: a paused queue has free slots and starts nothing, and
  // saying "starts now" there is a promise this cannot keep.
  if (paused) {
    return 'The queue is paused, so nothing new starts until you resume it.'
  }
  if (running >= capacity) {
    return 'Every slot is busy. The next piece of work waits for one.'
  }
  const free = capacity - running
  const off = MAX_SLOTS - capacity
  const spare = `${free} slot${free === 1 ? '' : 's'} free, so the next piece of work starts now.`
  return off === 0 ? spare : `${spare} ${off} switched off.`
}

function MeterSkeleton({ collapsed }: { collapsed: boolean }) {
  if (collapsed) {
    return <Skeleton className="h-4" />
  }
  return (
    <div className="rounded-[var(--radius)] border border-border bg-background p-3">
      <Skeleton className="mb-2 h-4 w-32" />
      <Skeleton className="h-1.5 w-full rounded-full" />
    </div>
  )
}
