import { PanelLeft } from 'lucide-react'
import { AnimatedSidebarTrigger } from '@/components/motion/animated-sidebar'
import { cn } from '@/lib/utils'
import type { StreamState } from '@/modules/api/events'
import { TauriOnly } from '@/modules/host/TauriOnly'

/**
 * The strip above the content, which means two different things per host.
 *
 * In the desktop window it is how the window is dragged, and the traffic
 * lights float over it because the title bar is an overlay. In a browser tab
 * the chrome is the browser's own, so the drag surface would be a lie and the
 * inset would be dead space.
 */
export function TitleBar({
  crumb,
  stream,
}: {
  crumb: string
  stream: StreamState
}) {
  return (
    <div className="relative flex h-[38px] shrink-0 items-center border-border border-b px-3">
      <TauriOnly feature="window dragging">
        <DragSurface />
      </TauriOnly>
      {/*
        The only way to reach navigation below 768px, where the sidebar becomes
        an off-canvas sheet. Both beUI and shadcn put it in the inset header,
        which is this bar. size-11 clears the 44px touch minimum; a pointer is
        likely from md up, so it drops to the component's own 40px there.
      */}
      <AnimatedSidebarTrigger className="relative mr-2 -ml-1 size-11 shrink-0 text-muted-foreground md:size-10">
        <PanelLeft className="size-4" />
      </AnimatedSidebarTrigger>
      <span className="relative font-mono text-[11px] text-muted-foreground">
        {crumb}
      </span>
      <StreamDot state={stream} />
    </div>
  )
}

/**
 * Covers the strip so the window moves when it is dragged.
 *
 * Absolute rather than wrapping the crumb, because the whole strip should drag
 * and text selection inside a drag region does not work anyway. The strip
 * itself has to be the positioning context: without that this resolves against
 * whatever ancestor happens to be positioned and swallows the clicks of the
 * entire pane below it.
 */
function DragSurface() {
  return <div data-tauri-drag-region className="absolute inset-0" />
}

/**
 * Whether the factory is still talking to us.
 *
 * Silent when live, because a connection that works is not news. A factory
 * that looks idle when it is actually unreachable is the worst failure this
 * interface can have, so the other two states say so.
 */
function StreamDot({ state }: { state: StreamState }) {
  if (state === 'live') {
    return null
  }
  return (
    <span className="relative ml-auto flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
      <span
        className={cn(
          'size-[6px] rounded-full',
          state === 'lost' ? 'bg-destructive' : 'bg-muted-foreground',
        )}
      />
      {state === 'lost' ? 'factory unreachable' : 'connecting'}
    </span>
  )
}
