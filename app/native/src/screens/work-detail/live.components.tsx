import { type StationId, type StepActivity, stationName } from 'aalai/shared'
import { useEffect, useState } from 'react'
import { AnimatedNumber } from '@/components/motion/animated-number'
import { cn } from '@/lib/utils'

/**
 * The parts of the thread that move.
 *
 * Every one of them reports a state change. Nothing here animates to look
 * alive: the banner appears because a station started, the bar advances
 * because a count rose, and the dots run only while something is actually
 * running.
 */

/** A three dot wave, used wherever a station is mid turn. */
function Dots({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-[3px]', className)}>
      {DOTS.map((i) => (
        <span
          key={i}
          style={{ animationDelay: `${i * 0.16}s` }}
          className="size-1 animate-[work-wave_1.25s_ease-in-out_infinite] rounded-full bg-current"
        />
      ))}
    </span>
  )
}

const DOTS = [0, 1, 2]

/**
 * What is happening, pinned where it can be read from anywhere in the thread.
 *
 * A long thread is mostly history, so a person scrolled into the middle of it
 * has no way to tell whether anything is still running. This says so without
 * them having to go and look.
 */
export function WorkingBanner({
  station,
  slot,
}: {
  station: StationId
  slot: { running: number; capacity: number } | null
}) {
  return (
    <div className="sticky top-0 z-20 mx-4 mt-3 mb-1 flex animate-[work-slide-down_.3s_cubic-bezier(.22,.61,.36,1)] items-center gap-2.5 rounded-[calc(var(--radius)-2px)] border border-[color-mix(in_oklab,var(--chart-2)_28%,var(--background))] bg-[color-mix(in_oklab,var(--chart-2)_10%,var(--background))] px-3.5 py-2.5 font-medium text-[13px] text-[var(--chart-2)] md:mx-6">
      <Dots />
      <span>{stationName(station)} is working</span>
      {slot === null ? null : (
        <span className="ml-auto font-normal text-[12px] text-muted-foreground">
          slot {slot.running} of {slot.capacity}
        </span>
      )}
    </div>
  )
}

/**
 * The step running right now, lifted out of the plan into the thread.
 *
 * One card at a time, always the live one. The plan stays where it is as the
 * record of what was agreed; this is the part of it that is happening.
 */
export function LiveStep({
  live,
  title,
  detail,
}: {
  live: StepActivity
  title: string
  detail?: string
}) {
  return (
    <div className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-md border border-[color-mix(in_oklab,var(--chart-2)_40%,var(--card))] bg-[color-mix(in_oklab,var(--chart-2)_10%,var(--card))] font-mono font-semibold text-[10px] text-[var(--chart-2)]">
        {stationName(live.station).charAt(0)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
          <b className="font-semibold text-[12px] text-foreground">
            {stationName(live.station)}
          </b>
          <Dots className="text-[var(--chart-2)]" />
          <Elapsed since={live.startedAt} />
        </div>
        <div className="rounded-[calc(var(--radius)-2px)] border border-border border-l-[3px] border-l-[var(--chart-2)] bg-card px-4 py-3">
          <h4 className="mb-1 font-semibold text-[13.5px]">{title}</h4>
          {detail === undefined ? null : (
            <p className="m-0 max-w-[62ch] text-[13px] text-muted-foreground">
              {detail}
            </p>
          )}
          {live.progress === undefined ? null : (
            <SubProgress progress={live.progress} />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * How far through the step it is, in the units the step chose.
 *
 * The one thing a long step has to keep saying. Without it a step that takes
 * five minutes is indistinguishable from one that has hung, which is the
 * failure this whole change exists to avoid.
 */
function SubProgress({
  progress,
}: {
  progress: NonNullable<StepActivity['progress']>
}) {
  const ratio = Math.min(1, progress.done / progress.total)
  return (
    <div className="mt-3 flex items-center gap-2.5 border-border border-t pt-3 font-mono text-[11.5px] text-muted-foreground">
      <span>{progress.label}</span>
      <span className="block h-1 max-w-[180px] flex-1 overflow-hidden rounded-full bg-secondary">
        <span
          style={{ width: `${ratio * 100}%` }}
          className="block h-full rounded-full bg-[var(--chart-2)] transition-[width] duration-300 ease-linear"
        />
      </span>
      <span className="tabular-nums">
        <AnimatedNumber value={progress.done} /> of {progress.total}{' '}
        {progress.unit}
      </span>
    </div>
  )
}

/**
 * How long this step has been going, counted here rather than sent.
 *
 * The server would have to emit a tick a second for every running step to say
 * the same thing, and the start time is already known.
 */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())

  // The one legitimate effect: a timer tied to a value, which is neither a
  // render nor an event handler.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const seconds = Math.max(0, Math.round((now - since) / 1000))
  if (seconds < 60) {
    return <span>working for {seconds}s</span>
  }
  const minutes = Math.floor(seconds / 60)
  return (
    <span>
      working for {minutes} minute{minutes === 1 ? '' : 's'}
    </span>
  )
}
