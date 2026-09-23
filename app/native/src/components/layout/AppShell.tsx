import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { Inbox, Workflow } from 'lucide-react'
import type { ComponentType } from 'react'
import {
  AnimatedSidebar,
  AnimatedSidebarContent,
  AnimatedSidebarGroup,
  AnimatedSidebarGroupContent,
  AnimatedSidebarHeader,
  AnimatedSidebarInset,
  AnimatedSidebarMenu,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuItem,
  AnimatedSidebarProvider,
} from '@/components/motion/animated-sidebar'

interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
}

// Only routes that exist. Repos and Documents arrive with their routes
// rather than as nav items that navigate nowhere.
const NAV: NavItem[] = [
  { to: '/', label: 'Inbox', icon: Inbox },
  { to: '/runs', label: 'Runs', icon: Workflow },
]

/**
 * The window frame: a sidebar that does not change and a body that does.
 *
 * The title bar is left empty because the window is dragged by it and the
 * traffic lights sit there, so anything placed in it collides with the OS.
 */
export function AppShell({ pending }: { pending?: number }) {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const navigate = useNavigate()

  return (
    <AnimatedSidebarProvider
      defaultOpen
      className="bg-background text-foreground flex h-dvh w-full overflow-hidden"
    >
        <AnimatedSidebar collapsible="icon" ariaLabel="Sections">
          <AnimatedSidebarHeader>
            <span className="font-heading text-[15px] font-semibold tracking-tight">aalai</span>
          </AnimatedSidebarHeader>

          <AnimatedSidebarContent>
            <AnimatedSidebarGroup>
              <AnimatedSidebarGroupContent>
                <AnimatedSidebarMenu>
                  {NAV.map((item) => {
                    const Icon = item.icon
                    const active = item.to === '/' ? path === '/' : path.startsWith(item.to)
                    return (
                      <AnimatedSidebarMenuItem key={item.to}>
                        <AnimatedSidebarMenuButton
                          icon={<Icon className="size-4" />}
                          isActive={active}
                          badge={item.to === '/' && pending ? pending : undefined}
                          onSelect={() => void navigate({ to: item.to })}
                        >
                          {item.label}
                        </AnimatedSidebarMenuButton>
                      </AnimatedSidebarMenuItem>
                    )
                  })}
                </AnimatedSidebarMenu>
              </AnimatedSidebarGroupContent>
            </AnimatedSidebarGroup>
          </AnimatedSidebarContent>

        </AnimatedSidebar>

        <AnimatedSidebarInset className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
          <div
            data-tauri-drag-region
            className="border-border flex h-[38px] shrink-0 items-center border-b px-3"
          >
            <span className="text-muted-foreground font-mono text-[11px]">{crumb(path)}</span>
          </div>
          <main className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <Outlet />
          </main>
        </AnimatedSidebarInset>
    </AnimatedSidebarProvider>
  )
}

function crumb(path: string): string {
  if (path === '/') return 'aalai / inbox'
  return `aalai${path.replace(/\//g, ' / ')}`
}
