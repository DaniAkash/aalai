import { Component, type ErrorInfo, type ReactNode } from 'react'
import { isDesktop } from './host'

export interface TauriOnlyProps {
  readonly children: ReactNode
  /** Named in the console when something inside genuinely fails. */
  readonly feature?: string
}

/**
 * Renders its children only where the desktop shell exists.
 *
 * Two different situations, handled differently on purpose.
 *
 * Not running in the desktop app is expected, so it renders nothing and says
 * nothing. Throwing here instead would be caught by the boundary below and
 * still reach the console, because React logs an error that crossed a boundary
 * whether or not the boundary handled it, and a red console on every page load
 * teaches people to ignore the console.
 *
 * Running in the desktop app and failing anyway is a fault, and the boundary
 * takes down this subtree alone so a broken window control cannot blank the
 * interface around it.
 *
 * Boundaries only catch what throws while rendering, never from an event
 * handler or a promise. A capability invoked from a click needs a function
 * that works in both hosts, as `openExternal` does, rather than this.
 */
export function TauriOnly({
  children,
  feature = 'a desktop feature',
}: TauriOnlyProps) {
  if (!isDesktop()) {
    return null
  }
  return <HostBoundary feature={feature}>{children}</HostBoundary>
}

/**
 * Unmounts a subtree that failed, and only that subtree.
 *
 * Class based because React 19 still has no hook form of componentDidCatch.
 */
class HostBoundary extends Component<
  { children: ReactNode; feature: string },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The one place a swallowed fault must stay visible. This boundary exists
    // to remove a broken subtree quietly, and quietly removing it without
    // saying so anywhere is how a feature disappears for a week unnoticed.
    // biome-ignore lint/suspicious/noConsole: the boundary's only report
    console.error(
      `${this.props.feature} failed and was removed`,
      error,
      info.componentStack,
    )
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
