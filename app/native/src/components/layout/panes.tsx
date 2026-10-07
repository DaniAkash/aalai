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
 * composer wants and the two pane split the thread wants arrive with those
 * screens, rather than sitting here unused in the meantime.
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
