import { TauriOnly } from '@/modules/host/TauriOnly'

/**
 * The strip above the content, which means two different things per host.
 *
 * In the desktop window it is how the window is dragged, and the traffic
 * lights float over it because the title bar is an overlay. In a browser tab
 * the chrome is the browser's own, so the drag surface would be a lie and the
 * inset would be dead space.
 */
export function TitleBar({ crumb }: { crumb: string }) {
  return (
    <div className="flex h-[38px] shrink-0 items-center border-border border-b px-3">
      <TauriOnly feature="window dragging">
        <DragSurface />
      </TauriOnly>
      <span className="relative font-mono text-[11px] text-muted-foreground">
        {crumb}
      </span>
    </div>
  )
}

/**
 * Covers the strip so the window moves when it is dragged.
 *
 * Absolute rather than wrapping the crumb, because the whole strip should drag
 * and text selection inside a drag region does not work anyway.
 */
function DragSurface() {
  return <div data-tauri-drag-region className="absolute inset-0" />
}
