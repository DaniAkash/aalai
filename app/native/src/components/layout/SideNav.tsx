import { useNavigate, useRouterState } from '@tanstack/react-router'
import {
  GitBranch,
  Inbox,
  LayoutList,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react'
import type { ComponentType } from 'react'
import {
  AnimatedSidebarGroup,
  AnimatedSidebarGroupContent,
  AnimatedSidebarMenu,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuItem,
} from '@/components/motion/animated-sidebar'
import { useOpenGates } from '@/modules/api/gates.hooks'

interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
}

/**
 * Only destinations that exist.
 *
 * Stations is absent until it has a route, because a nav item that navigates
 * nowhere is worse than a missing one.
 */
const NAV: NavItem[] = [
  { to: '/', label: 'Work', icon: LayoutList },
  { to: '/inbox', label: 'Inbox', icon: Inbox },
  { to: '/queue', label: 'Queue', icon: SlidersHorizontal },
  { to: '/repos', label: 'Repos', icon: GitBranch },
  { to: '/settings', label: 'Settings', icon: Settings2 },
]

export function SideNav() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const navigate = useNavigate()
  const gates = useOpenGates()
  const waiting = gates.data?.gates.length ?? 0

  return (
    <AnimatedSidebarGroup>
      <AnimatedSidebarGroupContent>
        <AnimatedSidebarMenu>
          {NAV.map((item) => {
            const Icon = item.icon
            return (
              <AnimatedSidebarMenuItem key={item.to}>
                <AnimatedSidebarMenuButton
                  icon={<Icon className="size-4" />}
                  isActive={isActive(path, item.to)}
                  badge={
                    item.to === '/inbox' && waiting > 0 ? waiting : undefined
                  }
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
  )
}

function isActive(path: string, to: string): boolean {
  return to === '/' ? path === '/' : path.startsWith(to)
}
