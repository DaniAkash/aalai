import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import type { ReactNode } from 'react'

/** Skeletons match the shape of the rows they stand in for, not a spinner. */
export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => `skeleton-${i}`).map((key) => (
        <div
          key={key}
          className="h-14 animate-pulse rounded-xl border border-border bg-muted/40"
        />
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
      <CheckCircle2 className="mx-auto size-7 text-muted-foreground" />
      <div className="mt-3 font-heading text-[15px]">{title}</div>
      <p className="mx-auto mt-1 max-w-[44ch] text-[13px] text-muted-foreground">
        {detail}
      </p>
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
export function ErrorNote({
  message,
  onRetry,
}: {
  message: string
  onRetry?: () => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3.5">
      <AlertTriangle className="size-5 shrink-0 text-destructive" />
      <div className="flex-1">
        <div className="font-medium text-[13px]">
          Could not reach the factory
        </div>
        <div className="text-[12.5px] text-muted-foreground">{message}</div>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-border px-3 py-1.5 text-[12px] hover:border-muted-foreground"
        >
          Retry
        </button>
      ) : null}
    </div>
  )
}
