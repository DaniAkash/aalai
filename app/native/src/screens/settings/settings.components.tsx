import type { ReactNode } from 'react'

export function Field({
  label,
  detail,
  children,
}: {
  label: string
  detail: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col items-stretch gap-2 border-border border-b py-3 last:border-b-0 md:flex-row md:items-center md:gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-[14px]">{label}</div>
        <div className="max-w-[60ch] text-[13px] text-muted-foreground">
          {detail}
        </div>
      </div>
      {children}
    </div>
  )
}

/**
 * A number that saves when you leave it, not on every keystroke.
 *
 * Saving per character would send a request for "6" on the way to "60" and
 * briefly set a poll interval nobody asked for.
 */
export function NumberField({
  value,
  min,
  onCommit,
}: {
  value: number
  min: number
  onCommit: (next: number) => void
}) {
  return (
    <input
      type="number"
      min={min}
      defaultValue={value}
      onBlur={(event) => {
        const next = Number(event.target.value)
        if (Number.isSafeInteger(next) && next >= min && next !== value) {
          onCommit(next)
        }
      }}
      className="min-h-11 w-24 shrink-0 rounded-lg border border-border bg-card px-2.5 py-1.5 text-right font-mono text-[12.5px] outline-none focus:border-ring lg:min-h-0"
    />
  )
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      // The pill stays 40x24. The target around it grows to 44 on a phone,
      // so the hit area clears the minimum without the control changing size.
      className="grid size-11 shrink-0 place-items-center lg:size-auto"
    >
      <span
        className={`flex h-6 w-10 items-center rounded-full border transition-colors ${
          checked ? 'border-primary bg-primary' : 'border-border bg-card'
        }`}
      >
        <span
          className={`block size-4 rounded-full bg-background transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-1'
          }`}
        />
      </span>
    </button>
  )
}

const PARALLEL_MIN = 1
const PARALLEL_MAX = 4

/**
 * What each setting costs, rather than what it is.
 *
 * A number between one and four means nothing until you know it buys a coding
 * agent and a checkout each, on the machine you are also using.
 */
const PARALLEL_DETAIL: Record<number, string> = {
  1: 'One at a time. The safest on a laptop you are also working on.',
  2: 'Two at a time. One long run cannot block everything behind it.',
  3: 'Three at a time. Noticeable while you work.',
  4: 'Four at a time. Expect them to compete for the same disk and network.',
}

/** The ceiling, drawn as lanes so the number is something you can see. */
export function ParallelRuns({
  value,
  onChange,
}: {
  value: number
  onChange: (next: number) => void
}) {
  return (
    <div className="flex flex-col items-stretch gap-2">
      <div className="flex items-center gap-2">
        <div className="flex items-center overflow-hidden rounded-lg border border-border bg-background">
          <button
            type="button"
            aria-label="fewer runs at the same time"
            data-testid="parallel-down"
            disabled={value <= PARALLEL_MIN}
            onClick={() => onChange(Math.max(PARALLEL_MIN, value - 1))}
            className="h-9 w-9 text-[17px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          >
            &minus;
          </button>
          <div
            className="w-10 text-center font-heading font-semibold text-[16px] tabular-nums"
            data-testid="parallel-value"
          >
            {value}
          </div>
          <button
            type="button"
            aria-label="more runs at the same time"
            data-testid="parallel-up"
            disabled={value >= PARALLEL_MAX}
            onClick={() => onChange(Math.min(PARALLEL_MAX, value + 1))}
            className="h-9 w-9 text-[17px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          >
            +
          </button>
        </div>
        <div className="flex flex-1 gap-1" aria-hidden="true">
          {Array.from({ length: PARALLEL_MAX }, (_, i) => i).map((i) => (
            <div
              key={i}
              className={
                i < value
                  ? 'h-8 flex-1 rounded-md border border-chart-2/45 bg-chart-2/10'
                  : 'h-8 flex-1 rounded-md border border-border border-dashed'
              }
            />
          ))}
        </div>
      </div>
      <p
        className="text-[11.5px] text-muted-foreground"
        data-testid="parallel-detail"
      >
        {PARALLEL_DETAIL[value]}
      </p>
    </div>
  )
}
