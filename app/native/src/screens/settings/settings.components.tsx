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
        <div className="text-[13.5px]">{label}</div>
        <div className="text-[12px] text-muted-foreground">{detail}</div>
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
      className="w-24 shrink-0 rounded-lg border border-border bg-card px-2.5 py-1.5 text-right font-mono text-[12.5px] outline-none focus:border-ring"
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
      className={`h-6 w-10 shrink-0 rounded-full border transition-colors ${
        checked ? 'border-primary bg-primary' : 'border-border bg-card'
      }`}
    >
      <span
        className={`block size-4 rounded-full bg-background transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-1'
        }`}
      />
    </button>
  )
}
