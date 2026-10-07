import { LANE_COPY } from 'aalai/shared'
import { ChevronDown, ChevronRight, Play } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/motion/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { GithubMark } from '@/components/ui/svgs/github'
import { cn } from '@/lib/utils'
import type { WorkItem } from '@/modules/api/work.hooks'
import { since, stationInitial } from './work-list.helpers'

/** The pills across the top. One is always selected, so none is a reset. */
export function Filters({
  value,
  onSelect,
  options,
}: {
  value: string
  onSelect: (key: string) => void
  options: readonly { key: string; label: string; count: number }[]
}) {
  return (
    <div className="mb-5 flex flex-wrap gap-1" role="tablist">
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          role="tab"
          aria-selected={option.key === value}
          onClick={() => onSelect(option.key)}
          className={cn(
            'rounded-full border px-3 py-1 font-medium text-[13px] transition-colors active:translate-y-px',
            option.key === value
              ? 'border-border bg-secondary text-foreground'
              : 'border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          {option.label}
          <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
            {option.count}
          </span>
        </button>
      ))}
    </div>
  )
}

export function Lane({
  lane,
  count,
  open,
  onToggle,
  children,
}: {
  lane: keyof typeof LANE_COPY
  count: number
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <Collapsible open={open} onOpenChange={onToggle} className="mb-6 block">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-0.5 pb-2 text-left">
        <h2 className="font-heading font-semibold text-[13px]">
          {LANE_COPY[lane].label}
        </h2>
        <span className="font-mono text-[11.5px] text-muted-foreground">
          {count}
        </span>
        <ChevronDown
          className={cn(
            'ml-auto size-3.5 text-muted-foreground transition-transform',
            !open && '-rotate-90',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent contentClassName="flex flex-col gap-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * One piece of work.
 *
 * There is no status badge anywhere in this row. A bar plus the name of what
 * is happening is strictly more information in strictly less space, and a row
 * with nothing left to do drops the bar rather than showing a full one.
 */
export function WorkRow({
  item,
  onOpen,
  onStart,
  starting,
}: {
  item: WorkItem
  onOpen: () => void
  onStart?: () => void
  starting?: boolean
}) {
  const live = item.lane === 'running'
  return (
    <div
      className={cn(
        'relative rounded-[var(--radius)] border bg-card transition-colors',
        live
          ? 'border-[color-mix(in_oklab,var(--chart-2)_28%,var(--card))]'
          : 'border-border hover:border-ring',
      )}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <Avatar station={item.station} lane={item.lane} />
        {/*
          The title stretches its hit area over the whole card rather than the
          card being a button, so Start can sit beside it. A button inside a
          button is invalid and the inner one stops receiving its own clicks.
        */}
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left after:absolute after:inset-0 after:content-['']"
        >
          <span className="block font-medium leading-snug">{item.title}</span>
          <Meta item={item} />
        </button>
        {onStart ? (
          <button
            type="button"
            onClick={onStart}
            disabled={starting}
            className="relative z-10 inline-flex shrink-0 items-center gap-1.5 rounded-[calc(var(--radius)-2px)] border border-border bg-card px-3 py-1.5 font-medium text-[13px] transition-colors hover:bg-secondary active:translate-y-px disabled:opacity-60"
          >
            <Play className="size-3.5" />
            {starting ? 'Starting' : 'Start'}
          </button>
        ) : (
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
      </div>
      {live ? <Progress label={item.station ?? 'working'} /> : null}
    </div>
  )
}

function Meta({ item }: { item: WorkItem }) {
  const bits = [
    item.station,
    item.branch,
    item.prUrl ? `#${item.number}` : null,
    since(item.startedAt),
  ].filter((bit): bit is string => Boolean(bit))
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
      <span className="font-mono text-[11.5px]">{item.repo}</span>
      {bits.map((bit) => (
        <span key={bit} className="flex items-center gap-2">
          <span aria-hidden>&middot;</span>
          {bit}
        </span>
      ))}
    </span>
  )
}

/**
 * Indeterminate on purpose, for now.
 *
 * A determinate bar needs a step count and a step index, which arrive with the
 * tools that report them. Showing a made up percentage in the meantime would
 * be worse than showing motion and the name of the stage.
 */
function Progress({ label }: { label: string }) {
  return (
    <div className="px-4 pb-3">
      <div className="h-1 overflow-hidden rounded-full bg-secondary">
        <div className="h-full w-1/3 animate-[work-sweep_1.8s_ease-in-out_infinite] rounded-full bg-[var(--chart-2)]" />
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[12px] text-muted-foreground">
        <Dots />
        {label}
      </div>
    </div>
  )
}

const DOTS = [0, 1, 2]

function Dots() {
  return (
    <span className="inline-flex items-center gap-[3px] text-[var(--chart-2)]">
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

function Avatar({
  station,
  lane,
}: {
  station: string | null
  lane: WorkItem['lane']
}) {
  const initial = stationInitial(station)
  return (
    <span
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-md border font-mono font-semibold text-[10px]',
        lane === 'running'
          ? 'border-[color-mix(in_oklab,var(--chart-2)_40%,var(--card))] bg-[color-mix(in_oklab,var(--chart-2)_10%,var(--card))] text-[var(--chart-2)]'
          : 'border-border bg-secondary text-muted-foreground',
      )}
      title={station ?? 'not started'}
    >
      {initial === '' ? <GithubMark className="size-3" /> : initial}
    </span>
  )
}

/** The shape of a row, not a spinner. */
export function RowSkeleton() {
  return (
    <div className="rounded-[var(--radius)] border border-border bg-card px-4 py-3">
      <Skeleton className="h-3.5 w-[62%]" />
      <Skeleton className="mt-2.5 h-3 w-[38%]" />
    </div>
  )
}
