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
  useAnimatedSidebar,
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
  const { state, setOpen } = useAnimatedSidebar()
  const collapsed = state === 'collapsed'

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
        <Search_
          collapsed={collapsed}
          value={filter}
          onChange={setFilter}
          onExpand={() => setOpen(true)}
        />
      </AnimatedSidebarGroup>

      <Section
        label="Needs you"
        empty="Nothing is waiting on you."
        collapsed={collapsed}
      >
        {needsYou.map((item) => (
          <Entry
            key={item.id}
            icon={<KindIcon kind={item.kind} />}
            label={item.title}
            collapsed={collapsed}
            onSelect={toWork}
          >
            {item.title}
          </Entry>
        ))}
      </Section>

      <Section
        label="Recent work"
        empty="Work you start appears here."
        collapsed={collapsed}
      >
        {recent.map((item) => (
          <Entry
            key={item.id}
            icon={
              <Initial station={item.station} live={item.lane === 'running'} />
            }
            label={item.title}
            collapsed={collapsed}
            onSelect={toWork}
          >
            {item.title}
          </Entry>
        ))}
      </Section>

      <Section
        label="Repositories"
        empty="Add a repository and aalai will watch it."
        collapsed={collapsed}
      >
        {watched.map((repo) => (
          <Entry
            key={repo}
            icon={<GithubMark className="size-3.5" />}
            label={repo}
            collapsed={collapsed}
            badge={
              items.filter((item) => item.repo === repo).length || undefined
            }
            onSelect={() => void navigate({ to: '/repos' })}
          >
            <span className="font-mono text-[12px]">{repo}</span>
          </Entry>
        ))}
      </Section>
    </>
  )
}

/**
 * A heading, the rows, and what to say when there are none.
 *
 * The empty line sits outside the menu list rather than among its items. The
 * menu wraps each child in its own element, so a paragraph placed in there
 * ends up containing a div, which is invalid and which React refuses to nest.
 */
/**
 * A search field that becomes a button when there is no room for one.
 *
 * At 68px a text input is a box a person cannot read, type into or recognise.
 * Collapsed it is the icon alone, and pressing it opens the sidebar and puts
 * the cursor in the field, so the control still does what its icon promises.
 */
function Search_({
  collapsed,
  value,
  onChange,
  onExpand,
}: {
  collapsed: boolean
  value: string
  onChange: (next: string) => void
  onExpand: () => void
}) {
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onExpand}
        aria-label="Find work or a repository"
        className="grid size-8 w-full place-items-center rounded-[calc(var(--radius)-2px)] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <Search className="size-4" />
      </button>
    )
  }
  return (
    <Input
      value={value}
      onChange={onChange}
      placeholder="Find work or a repository"
      aria-label="Find work or a repository"
      leftIcon={<Search className="size-3.5" />}
      className="h-8 text-[13px]"
    />
  )
}

/**
 * A heading, the rows, and what to say when there are none.
 *
 * The empty line sits outside the menu list rather than among its items. The
 * menu wraps each child in its own element, so a paragraph placed in there
 * ends up containing a div, which is invalid and which React refuses to nest.
 *
 * Collapsed, the line is dropped rather than wrapped: a sentence reflowed into
 * a 68px column is four words of nonsense stacked vertically, and the heading
 * it belonged to has already faded out.
 */
function Section({
  label,
  empty,
  collapsed,
  children,
}: {
  label: string
  empty: string
  collapsed: boolean
  children: ReactNode[]
}) {
  return (
    <AnimatedSidebarGroup>
      <AnimatedSidebarGroupLabel>{label}</AnimatedSidebarGroupLabel>
      <AnimatedSidebarGroupContent>
        {children.length === 0 ? (
          collapsed ? null : (
            <p className="px-2 py-1 text-[12px] text-muted-foreground">
              {empty}
            </p>
          )
        ) : (
          <AnimatedSidebarMenu>{children}</AnimatedSidebarMenu>
        )}
      </AnimatedSidebarGroupContent>
    </AnimatedSidebarGroup>
  )
}

/**
 * One row, with its name reachable when the sidebar has hidden it.
 *
 * Collapsed, every row in a section is the same glyph, so the label has to be
 * available some other way or the rail is four identical marks.
 */
function Entry({
  icon,
  badge,
  label,
  collapsed,
  onSelect,
  children,
}: {
  icon: ReactNode
  badge?: number
  label: string
  collapsed: boolean
  onSelect: () => void
  children: ReactNode
}) {
  // A native title rather than the registry tooltip. That component drives its
  // child by cloning it, and the menu button declares an explicit prop list
  // with no rest spread, so the handlers it clones in are dropped and nothing
  // ever opens. The title bar uses the real tooltip, where the child is a
  // plain button and the cloning lands.
  return (
    <AnimatedSidebarMenuItem>
      <span className="block" title={collapsed ? label : undefined}>
        <AnimatedSidebarMenuButton
          icon={icon}
          badge={badge}
          onSelect={onSelect}
        >
          {children}
        </AnimatedSidebarMenuButton>
      </span>
    </AnimatedSidebarMenuItem>
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
