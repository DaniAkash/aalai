import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { FileText, GitBranch, Inbox, PauseCircle, SlidersHorizontal, Workflow } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
  count?: number
}

const NAV: NavItem[] = [
  { to: '/', label: 'Inbox', icon: Inbox },
  { to: '/runs', label: 'Runs', icon: Workflow },
  { to: '/repos', label: 'Repos', icon: GitBranch },
  { to: '/docs', label: 'Documents', icon: FileText },
]

/**
 * The window frame. A sidebar that never changes and a body that does.
 *
 * The title bar is left empty on purpose: the window is dragged by it and the
 * traffic lights sit there, so anything placed in it collides with the OS.
 */
export function AppShell({ pending }: { pending?: number }) {
  const path = useRouterState({ select: (s) => s.location.pathname })

  return (
    <div className="bg-background text-foreground grid h-dvh grid-cols-[200px_minmax(0,1fr)] grid-rows-[38px_minmax(0,1fr)] overflow-hidden">
      <div
        data-tauri-drag-region
        className="border-border bg-sidebar col-span-2 flex items-center border-b px-3"
      >
        <span className="text-muted-foreground ml-16 font-mono text-[11px]">{crumb(path)}</span>
      </div>

      <nav className="border-border bg-sidebar flex flex-col gap-0.5 border-r p-2.5">
        <div className="font-heading px-2 pt-1 pb-3 text-[15px] font-semibold tracking-tight">
          aalai
        </div>
        {NAV.map((item) => {
          const active = item.to === '/' ? path === '/' : path.startsWith(item.to)
          const Icon = item.icon
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                'flex items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-1.5 text-[13px]',
                active
                  ? 'border-primary/30 bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
            >
              <Icon className="size-4" />
              {item.label}
              {item.to === '/' && pending ? (
                <span className="bg-chart-4 text-background ml-auto rounded-full px-1.5 font-mono text-[10px] font-semibold">
                  {pending}
                </span>
              ) : null}
            </Link>
          )
        })}
        <div className="flex-1" />
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px]"
        >
          <SlidersHorizontal className="size-4" />
          Settings
        </button>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px]"
        >
          <PauseCircle className="size-4" />
          Pause factory
        </button>
      </nav>

      <main className="overflow-y-auto px-6 py-5">
        <Outlet />
      </main>
    </div>
  )
}

function crumb(path: string): string {
  if (path === '/') return 'aalai / inbox'
  return `aalai${path.replace(/\//g, ' / ')}`
}
