import { useNavigate, useRouterState } from '@tanstack/react-router'
import {
  GitBranch,
  Inbox,
  PanelLeft,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { AnimatedSidebarTrigger } from '@/components/motion/animated-sidebar'
import { Tooltip } from '@/components/motion/tooltip'
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
    <div className="relative flex min-h-[38px] shrink-0 items-center border-border border-b px-3">
      <TauriOnly feature="window dragging">
        <DragSurface />
      </TauriOnly>
      {/*
        The only way to reach navigation below 768px, where the sidebar becomes
        an off-canvas sheet. Both beUI and shadcn put it in the inset header,
        which is this bar. size-11 clears the 44px touch minimum, and it holds
        until lg rather than md: 768 is iPad portrait, a touch context, so the
        denser 40px waits for a width where a pointer is actually likely.
      */}
      <AnimatedSidebarTrigger className="relative mr-2 -ml-1 size-11 shrink-0 text-muted-foreground lg:size-10">
        <PanelLeft className="size-4" />
      </AnimatedSidebarTrigger>
      <span className="relative min-w-0 truncate font-mono text-[11px] text-muted-foreground">
        {crumb}
      </span>
      <StreamDot state={stream} />
      <Destinations />
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
 * The screens that are genuinely somewhere else.
 *
 * Here rather than in the sidebar, because the sidebar is an index of the
 * work. These are small, rarely visited, and the same three on every screen,
 * which is what a toolbar is for.
 */
const DESTINATIONS: {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
}[] = [
  { to: '/inbox', label: 'Inbox', icon: Inbox },
  { to: '/queue', label: 'Queue', icon: SlidersHorizontal },
  { to: '/repos', label: 'Repositories', icon: GitBranch },
  { to: '/settings', label: 'Settings', icon: Settings2 },
]

function Destinations() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const navigate = useNavigate()
  return (
    <nav className="relative ml-auto flex items-center gap-0.5 pl-2">
      {DESTINATIONS.map((item) => {
        const Icon = item.icon
        const active = path.startsWith(item.to)
        return (
          <Tooltip key={item.to} content={item.label} side="bottom">
            <button
              type="button"
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              onClick={() => void navigate({ to: item.to })}
              className={cn(
                'grid size-7 place-items-center rounded-[calc(var(--radius)-4px)] transition-colors',
                active
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" />
            </button>
          </Tooltip>
        )
      })}
    </nav>
  )
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
