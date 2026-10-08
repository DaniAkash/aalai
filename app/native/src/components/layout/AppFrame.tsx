import { Outlet, useRouterState } from '@tanstack/react-router'
import { CapacityMeter } from '@/components/layout/CapacityMeter'
import { SideNav } from '@/components/layout/SideNav'
import { TitleBar } from '@/components/layout/TitleBar'
import {
  AnimatedSidebar,
  AnimatedSidebarContent,
  AnimatedSidebarFooter,
  AnimatedSidebarHeader,
  AnimatedSidebarInset,
  AnimatedSidebarProvider,
  useAnimatedSidebar,
} from '@/components/motion/animated-sidebar'
import { useLiveEvents } from '@/modules/api/live.hooks'
import { useGateOnActivation } from '@/modules/notify/useGateOnActivation'

/**
 * The window frame: a sidebar that does not change and a body that does.
 *
 * The body is no longer a single capped column. A screen picks its own shape
 * through the pane components, because a thread beside a diff and a list of
 * rows want different widths and the frame should not decide for them.
 *
 * The capacity meter sits in the footer, outside the scrolling content, so a
 * person with thirty repositories can still see how much of their machine is
 * in use.
 */
export function AppFrame() {
  // Mounted once, here, so one connection serves every screen and the cache
  // stays current no matter which one is open.
  const stream = useLiveEvents()
  useGateOnActivation()
  const crumb = useRouterState({ select: (s) => crumbFor(s.location.pathname) })

  return (
    <AnimatedSidebarProvider
      defaultOpen
      className="flex h-dvh w-full overflow-hidden bg-background text-foreground"
    >
      <AnimatedSidebar collapsible="icon" ariaLabel="Sections">
        <AnimatedSidebarHeader>
          <Brand />
        </AnimatedSidebarHeader>

        <AnimatedSidebarContent>
          <SideNav />
        </AnimatedSidebarContent>

        <AnimatedSidebarFooter>
          <CapacityMeter />
        </AnimatedSidebarFooter>
      </AnimatedSidebar>

      <AnimatedSidebarInset className="@container flex min-h-0 w-full min-w-0 flex-1 flex-col">
        <TitleBar crumb={crumb} stream={stream} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </AnimatedSidebarInset>
    </AnimatedSidebarProvider>
  )
}

/**
 * The trail, as a person reads it.
 *
 * Still derived from the path, because the routes that have a subject of their
 * own do not exist yet. When the thread arrives it supplies its own title
 * through route context and this stops guessing.
 */
function crumbFor(path: string): string {
  if (path === '/') {
    return 'aalai / work'
  }
  const [, section, id] = path.split('/')
  if (section === undefined || section === '') {
    return 'aalai'
  }
  if (id === undefined || id === '') {
    return `aalai / ${section}`
  }
  // The work detail puts its own title in an h1 directly below this, so the
  // trail names the section and stops rather than repeating it badly.
  if (section === 'work') {
    return 'aalai / work'
  }
  return `aalai / ${section} / ${section === 'gates' ? 'one gate' : 'one run'}`
}

/**
 * The name, and what it is, when the second one fits.
 *
 * Collapsed the sidebar is 68px, which the suffix does not fit inside and
 * would otherwise be clipped mid word against the title bar.
 */
function Brand() {
  const { state } = useAnimatedSidebar()
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="font-heading font-semibold text-[15px] tracking-tight">
        aalai
      </span>
      {state === 'collapsed' ? null : (
        <span className="truncate font-medium text-[10.5px] text-muted-foreground uppercase tracking-wider">
          factory
        </span>
      )}
    </span>
  )
}
