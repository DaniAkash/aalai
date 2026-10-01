import type { RunStatus } from 'aalai/shared'
import { statusLabel } from 'aalai/shared'
import { motion, useReducedMotion } from 'motion/react'
import { useId } from 'react'
import { cn } from '@/lib/utils'
import type { QueueEntry } from '@/modules/api/queue.hooks'

const GLIDE = { type: 'spring', stiffness: 420, damping: 36 } as const

/**
 * How much of the machine is in use, drawn rather than written.
 *
 * A number would be read and forgotten. Slots make "two of three" something
 * you see, which matters because the ceiling is the whole point of the screen.
 */
export function CapacityMeter({
  running,
  capacity,
}: {
  running: number
  capacity: number
}) {
  const reduce = useReducedMotion()
  return (
    <div className="flex gap-1.5" aria-hidden="true">
      {Array.from({ length: capacity }, (_, i) => i).map((i) => (
        <div
          key={i}
          className={cn(
            'relative grid h-8 w-10 place-items-center overflow-hidden rounded-md border',
            i < running
              ? 'border-chart-2/60 bg-chart-2/10 text-chart-2'
              : 'border-border bg-background text-muted-foreground',
          )}
        >
          <span className="font-medium text-[10px]">
            {i < running ? 'busy' : 'free'}
          </span>
          {i < running && !reduce ? (
            <motion.span
              className="absolute inset-x-0 bottom-0 h-[3px] origin-left bg-chart-2"
              initial={{ scaleX: 0.05 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 3.2, repeat: Number.POSITIVE_INFINITY }}
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}

export function StatusTabs({
  tabs,
  value,
  counts,
  onChange,
}: {
  tabs: readonly { key: RunStatus | 'all'; label: string }[]
  value: RunStatus | 'all'
  counts: Record<string, number>
  onChange: (next: RunStatus | 'all') => void
}) {
  const layoutId = useId()
  const reduce = useReducedMotion()
  return (
    <div
      className="mb-3 flex gap-0.5 overflow-x-auto border-border border-b [scrollbar-width:none]"
      role="tablist"
      aria-label="Run status"
    >
      {tabs.map((tab) => {
        const active = tab.key === value
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`tab-${tab.key}`}
            onClick={() => onChange(tab.key)}
            className={cn(
              'relative whitespace-nowrap px-2.5 pt-2 pb-2.5 text-[12.5px] transition-colors',
              active
                ? 'font-semibold text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            <span
              className={cn(
                'ml-1.5 rounded-full px-1.5 py-px text-[10.5px] tabular-nums',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {counts[tab.key] ?? 0}
            </span>
            {active && !reduce ? (
              <motion.span
                layoutId={layoutId}
                transition={GLIDE}
                className="absolute inset-x-0 -bottom-px h-0.5 rounded bg-primary"
              />
            ) : null}
            {active && reduce ? (
              <span className="absolute inset-x-0 -bottom-px h-0.5 rounded bg-primary" />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

const DOT: Record<RunStatus, string> = {
  offered: 'bg-muted-foreground/60',
  queued: 'bg-muted-foreground',
  running: 'bg-chart-2',
  blocked: 'bg-chart-1',
  stopped: 'bg-muted-foreground/60',
  delivered: 'bg-chart-2',
  failed: 'bg-destructive',
  skipped: 'bg-muted-foreground/40',
}

export function QueueRow({
  entry,
  position,
  actions,
}: {
  entry: QueueEntry
  position: number | null
  actions: React.ReactNode
}) {
  return (
    <div
      data-testid="queue-row"
      data-status={entry.status}
      className={cn(
        'flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5',
        entry.status === 'running' ? 'border-chart-2/45' : 'border-border',
      )}
    >
      <span className={cn('size-2 shrink-0 rounded-full', DOT[entry.status])} />
      {position === null ? null : (
        <span className="w-5 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
          {position}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="font-mono">{entry.repo}</span>
          <span className="font-mono text-muted-foreground">
            {entry.kind === 'pr' ? 'PR' : 'issue'} #{entry.number}
          </span>
          <span className="rounded-full border border-border px-1.5 text-[10.5px] text-muted-foreground">
            {statusLabel(entry.status)}
          </span>
        </span>
        {entry.title === null ? null : (
          <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
            {entry.title}
          </span>
        )}
        {entry.error === null ? null : (
          <span className="mt-0.5 block truncate text-[11.5px] text-destructive">
            {entry.error}
          </span>
        )}
      </span>
      <span className="flex shrink-0 gap-1.5">{actions}</span>
    </div>
  )
}

export function RowButton({
  children,
  onClick,
  primary,
  disabled,
  testId,
}: {
  children: React.ReactNode
  onClick: () => void
  primary?: boolean
  disabled?: boolean
  testId?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        'min-h-8 rounded-lg px-2.5 text-[11.5px] transition-colors disabled:opacity-40',
        primary
          ? 'bg-primary font-semibold text-primary-foreground hover:opacity-90'
          : 'border border-border text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
