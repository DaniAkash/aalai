import type { ReactNode } from 'react'

/**
 * The heading every surface shares, so they line up down to the pixel.
 *
 * The subtitle keeps its line even when empty, or the content below shifts as
 * a screen moves between its loading, empty and loaded states.
 */
export function Screen({
  title,
  sub,
  actions,
  children,
}: {
  title: string
  sub?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-heading font-semibold text-[19px] tracking-tight">
            {title}
          </h1>
          <p className="mb-5 text-[13px] text-muted-foreground">{sub ?? ' '}</p>
        </div>
        {actions}
      </div>
      {children}
    </>
  )
}

export function GroupHead({ label, count }: { label: string; count?: number }) {
  return (
    <div className="mb-2 flex items-center gap-2 font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
      {label}
      {count === undefined ? null : (
        <span className="text-foreground">{count}</span>
      )}
    </div>
  )
}
