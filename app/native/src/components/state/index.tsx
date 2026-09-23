import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import type { ReactNode } from 'react'

/** Skeletons match the shape of the rows they stand in for, not a spinner. */
export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="border-border bg-muted/40 h-14 animate-pulse rounded-xl border" />
      ))}
    </div>
  )
}

/** Empty is a state worth composing. It should read as calm, not broken. */
export function Empty({
  title,
  detail,
  action,
}: {
  title: string
  detail: string
  action?: ReactNode
}) {
  return (
    <div className="py-16 text-center">
      <CheckCircle2 className="text-muted-foreground mx-auto size-7" />
      <div className="font-heading mt-3 text-[15px]">{title}</div>
      <p className="text-muted-foreground mx-auto mt-1 max-w-[44ch] text-[13px]">{detail}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

/**
 * Errors are inline and keep whatever was already on screen.
 *
 * The window failing to reach the factory does not mean the factory stopped,
 * so this must not read like the run died.
 */
export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="border-destructive/40 bg-destructive/10 flex items-center gap-3 rounded-xl border p-3.5">
      <AlertTriangle className="text-destructive size-5 shrink-0" />
      <div className="flex-1">
        <div className="text-[13px] font-medium">Could not reach the factory</div>
        <div className="text-muted-foreground text-[12.5px]">{message}</div>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="border-border hover:border-muted-foreground rounded-lg border px-3 py-1.5 text-[12px]"
        >
          Retry
        </button>
      ) : null}
    </div>
  )
}
