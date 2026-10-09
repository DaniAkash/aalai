import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The body shapes a screen can ask for.
 *
 * There used to be one: a 72rem column, centred, for everything. A thread that
 * sits beside a diff cannot live inside that, and a single brief should not be
 * as wide as a list of thirty rows, so the shape became a decision the route
 * makes rather than a constant the frame imposes.
 *
 * Only the shape something renders in today lives here. The narrow column the
 * composer wants arrives with that screen, rather than sitting here unused in
 * the meantime.
 */

/** Rows and settings. Wide enough to scan, capped so prose stays readable. */
export function ReadingPane({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'mx-auto w-full max-w-[64rem] px-4 py-5 md:px-6',
        className,
      )}
    >
      {children}
    </div>
  )
}

/**
 * A thread with the changes beside it.
 *
 * The aside is sticky and scrolls on its own above 1100px, so reading the
 * conversation does not drag the diff off screen. Below that it stacks, which
 * is worse than two panes and better than a 380px column of code.
 *
 * `min-w-0` on the main column is load bearing: it is a grid item, whose
 * default `min-width: auto` would let one long unbroken path in a file list
 * widen the whole page instead of ellipsising.
 */
export function SplitPane({
  children,
  aside,
}: {
  children: ReactNode
  aside?: ReactNode
}) {
  if (!aside) {
    return (
      <div className="flex min-h-0 w-full min-w-0 flex-col">{children}</div>
    )
  }
  // An explicit 1100px rather than a named breakpoint. The nearest Tailwind
  // step is xl at 1280, which would leave the pane stacked across the whole
  // range this layout was measured at.
  return (
    <div className="grid min-h-0 w-full grid-cols-1 [@media(min-width:1100px)]:grid-cols-[minmax(0,1fr)_440px]">
      <div className="flex min-h-0 min-w-0 flex-col [@media(min-width:1100px)]:border-border [@media(min-width:1100px)]:border-r">
        {children}
      </div>
      <aside className="min-w-0 border-border border-t [@media(min-width:1100px)]:sticky [@media(min-width:1100px)]:top-0 [@media(min-width:1100px)]:h-[calc(100dvh-38px)] [@media(min-width:1100px)]:self-start [@media(min-width:1100px)]:overflow-y-auto [@media(min-width:1100px)]:border-t-0">
        {aside}
      </aside>
    </div>
  )
}
