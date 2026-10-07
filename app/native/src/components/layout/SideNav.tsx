import { useNavigate } from '@tanstack/react-router'
import {
  CircleDot,
  GitPullRequestArrow,
  MessageSquareWarning,
  Search,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import {
  AnimatedSidebarGroup,
  AnimatedSidebarGroupContent,
  AnimatedSidebarGroupLabel,
  AnimatedSidebarMenu,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuItem,
} from '@/components/motion/animated-sidebar'
import { Input } from '@/components/motion/input'
import { GithubMark } from '@/components/ui/svgs/github'
import { cn } from '@/lib/utils'
import { useWatchedRepos } from '@/modules/api/repos.hooks'
import { useWork, type WorkItem } from '@/modules/api/work.hooks'

/**
 * The sidebar is an index of the work, not a menu of screens.
 *
 * A menu answers "where can I go", which a person learns once and then never
 * needs again. These three sections answer what they actually ask every time
 * the window opens: what is waiting on me, what was I last doing, and which
 * repository is which. Navigation that is genuinely navigation sits in the
 * title bar instead.
 */
export function SideNav() {
  const [filter, setFilter] = useState('')
  const work = useWork({ variables: {} })
  const repos = useWatchedRepos()
  const navigate = useNavigate()

  const items = work.data?.lanes.flatMap((lane) => lane.items) ?? []
  const match = filter.trim().toLowerCase()
  const keep = (text: string) =>
    match === '' || text.toLowerCase().includes(match)

  const needsYou = items.filter((i) => i.lane === 'needsyou' && keep(i.title))
  const recent = items
    .filter(
      (i) => (i.lane === 'running' || i.lane === 'queued') && keep(i.title),
    )
    .slice(0, 5)
  const watched = (repos.data?.repos ?? [])
    .map((entry) => entry.repo)
    .filter(keep)

  const toWork = () => void navigate({ to: '/' })

  return (
    <>
      <AnimatedSidebarGroup>
        <Input
          value={filter}
          onChange={setFilter}
          placeholder="Find work or a repository"
          aria-label="Find work or a repository"
          leftIcon={<Search className="size-3.5" />}
          className="h-8 text-[13px]"
        />
      </AnimatedSidebarGroup>

      <Section label="Needs you">
        {needsYou.map((item) => (
          <Entry
            key={item.id}
            icon={<KindIcon kind={item.kind} />}
            onSelect={toWork}
          >
            {item.title}
          </Entry>
        ))}
        {needsYou.length === 0 ? (
          <Quiet>Nothing is waiting on you.</Quiet>
        ) : null}
      </Section>

      <Section label="Recent work">
        {recent.map((item) => (
          <Entry
            key={item.id}
            icon={
              <Initial station={item.station} live={item.lane === 'running'} />
            }
            onSelect={toWork}
          >
            {item.title}
          </Entry>
        ))}
        {recent.length === 0 ? (
          <Quiet>Work you start appears here.</Quiet>
        ) : null}
      </Section>

      <Section label="Repositories">
        {watched.map((repo) => (
          <Entry
            key={repo}
            icon={<GithubMark className="size-3.5" />}
            badge={
              items.filter((item) => item.repo === repo).length || undefined
            }
            onSelect={() => void navigate({ to: '/repos' })}
          >
            <span className="font-mono text-[12px]">{repo}</span>
          </Entry>
        ))}
        {watched.length === 0 ? (
          <Quiet>Add a repository and aalai will watch it.</Quiet>
        ) : null}
      </Section>
    </>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <AnimatedSidebarGroup>
      <AnimatedSidebarGroupLabel>{label}</AnimatedSidebarGroupLabel>
      <AnimatedSidebarGroupContent>
        <AnimatedSidebarMenu>{children}</AnimatedSidebarMenu>
      </AnimatedSidebarGroupContent>
    </AnimatedSidebarGroup>
  )
}

function Entry({
  icon,
  badge,
  onSelect,
  children,
}: {
  icon: ReactNode
  badge?: number
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <AnimatedSidebarMenuItem>
      <AnimatedSidebarMenuButton icon={icon} badge={badge} onSelect={onSelect}>
        {children}
      </AnimatedSidebarMenuButton>
    </AnimatedSidebarMenuItem>
  )
}

/** Says the section is empty by saying what will fill it. */
function Quiet({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-1 text-[12px] text-muted-foreground">{children}</p>
  )
}

/** What kind of thing is asking, so a row reads before it is read. */
function KindIcon({ kind }: { kind: WorkItem['kind'] }) {
  return kind === 'pr' ? (
    <GitPullRequestArrow className="size-4" />
  ) : (
    <MessageSquareWarning className="size-4" />
  )
}

function Initial({ station, live }: { station: string | null; live: boolean }) {
  const letter = station?.charAt(0).toUpperCase() ?? ''
  return (
    <span
      className={cn(
        'grid size-4.5 place-items-center rounded border font-mono font-semibold text-[9.5px]',
        live
          ? 'border-[color-mix(in_oklab,var(--chart-2)_40%,var(--sidebar))] bg-[color-mix(in_oklab,var(--chart-2)_12%,var(--sidebar))] text-[var(--chart-2)]'
          : 'border-border bg-secondary text-muted-foreground',
      )}
    >
      {letter === '' ? <CircleDot className="size-2.5" /> : letter}
    </span>
  )
}
