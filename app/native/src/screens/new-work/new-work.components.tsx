import type { WorkMode } from 'aalai/shared'
import { Cpu } from 'lucide-react'

/** The pieces of the composer that only describe what will happen. */

export function ModeLabel({ mode }: { mode: WorkMode }) {
  return (
    <span className="flex flex-col gap-0.5 text-left">
      <b className="font-semibold text-[12.5px]">{mode.label}</b>
      <small className="text-[11.5px] text-muted-foreground leading-snug">
        {mode.description}
      </small>
    </span>
  )
}

export interface QueueState {
  readonly running: number
  readonly capacity: number
  readonly paused: boolean
}

/**
 * What will actually happen to this piece of work when you send it.
 *
 * The one thing the composer can get wrong without looking wrong. Saying it
 * starts now when every slot is taken is the same class of lie as a progress
 * bar that does not move, so this reads the real ceiling and says which of the
 * two it is.
 */
export function CapacityAdvice({ queue }: { queue: QueueState | null }) {
  if (queue === null) {
    return null
  }
  const free = Math.max(0, queue.capacity - queue.running)
  return (
    <div className="mt-4 flex items-start gap-3 rounded-[calc(var(--radius)-2px)] border border-border bg-sidebar px-4 py-3">
      <Cpu className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="text-[13px]">
        <b className="font-semibold">{headline(queue, free)}</b>
        <p className="m-0 mt-0.5 text-muted-foreground">
          {detail(queue, free)}
        </p>
      </div>
    </div>
  )
}

function headline(queue: QueueState, free: number): string {
  if (queue.paused) {
    return 'The queue is paused'
  }
  if (free === 0) {
    return `All ${queue.capacity} slots are busy`
  }
  return `${queue.running} of ${queue.capacity} slots are busy`
}

function detail(queue: QueueState, free: number): string {
  if (queue.paused) {
    return 'This will be queued and will not start until you resume the queue in Stations.'
  }
  if (free === 0) {
    return 'This will wait for a slot rather than compete for the laptop. Raise the ceiling in Stations if you want more at once.'
  }
  return 'This starts straight away. Anything past the ceiling waits for a slot rather than competing for the laptop.'
}
