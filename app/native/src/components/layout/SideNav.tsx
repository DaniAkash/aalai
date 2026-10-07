import { useNavigate } from '@tanstack/react-router'
import {
  CircleDot,
  GitPullRequestArrow,
  MessageSquareWarning,
  Search,
} from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
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
  const searchId = useId()
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
    <div className="flex flex-col gap-0.5">
      <label className="sr-only" htmlFor={searchId}>
        Find work or a repository
      </label>
      <div className="mb-2 flex items-center gap-2 rounded-[calc(var(--radius)-2px)] border border-border bg-background px-2.5 py-1.5 text-muted-foreground focus-within:border-ring">
        <Search className="size-3.5 shrink-0" />
        <input
          id={searchId}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Find work or a repository"
          className="w-full border-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>

      <Section label="Needs you" count={needsYou.length}>
        {needsYou.map((item) => (
          <Row key={item.id} onSelect={toWork} title={item.title}>
            <KindIcon kind={item.kind} />
            <span className="truncate">{item.title}</span>
          </Row>
        ))}
        {needsYou.length === 0 ? (
          <Quiet>Nothing is waiting on you.</Quiet>
        ) : null}
      </Section>

      <Section label="Recent work">
        {recent.map((item) => (
          <Row key={item.id} onSelect={toWork} title={item.title}>
            <Initial station={item.station} live={item.lane === 'running'} />
            <span className="truncate">{item.title}</span>
          </Row>
        ))}
        {recent.length === 0 ? (
          <Quiet>Work you start appears here.</Quiet>
        ) : null}
      </Section>

      <Section label="Repositories">
        {watched.map((repo) => (
          <Row
            key={repo}
            onSelect={() => void navigate({ to: '/repos' })}
            title={repo}
          >
            <GithubMark className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-[12px]">{repo}</span>
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              {items.filter((item) => item.repo === repo).length}
            </span>
          </Row>
        ))}
        {watched.length === 0 ? (
          <Quiet>Add a repository and aalai will watch it.</Quiet>
        ) : null}
      </Section>
    </div>
  )
}

function Section({
  label,
  count,
  children,
}: {
  label: string
  count?: number
  children: ReactNode
}) {
  return (
    <>
      <div className="flex items-center justify-between px-2 pt-3 pb-1 font-semibold text-[11px] text-muted-foreground uppercase tracking-wider">
        <span>{label}</span>
        {count === undefined || count === 0 ? null : (
          <span className="font-mono tracking-normal">{count}</span>
        )}
      </div>
      {children}
    </>
  )
}

function Row({
  children,
  onSelect,
  title,
}: {
  children: ReactNode
  onSelect: () => void
  title: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={title}
      className="flex w-full items-center gap-2.5 rounded-[calc(var(--radius)-2px)] px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-secondary"
    >
      {children}
    </button>
  )
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-1 text-[12px] text-muted-foreground">{children}</p>
  )
}

/** What kind of thing is asking, so a row reads before it is read. */
function KindIcon({ kind }: { kind: WorkItem['kind'] }) {
  const className = 'size-3.5 shrink-0 text-muted-foreground'
  return kind === 'pr' ? (
    <GitPullRequestArrow className={className} />
  ) : (
    <MessageSquareWarning className={className} />
  )
}

function Initial({ station, live }: { station: string | null; live: boolean }) {
  const letter = station?.charAt(0).toUpperCase() ?? ''
  return (
    <span
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded border font-mono font-semibold text-[9.5px]',
        live
          ? 'border-[color-mix(in_oklab,var(--chart-2)_40%,var(--sidebar))] bg-[color-mix(in_oklab,var(--chart-2)_12%,var(--sidebar))] text-[var(--chart-2)]'
          : 'border-border bg-secondary text-muted-foreground',
      )}
    >
      {letter === '' ? <CircleDot className="size-2.5" /> : letter}
    </span>
  )
}
