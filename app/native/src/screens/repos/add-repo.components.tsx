import { type PickerRow, pushedLabel, starsLabel } from 'aalai/shared'
import { Building2, Check, Lock, User } from 'lucide-react'
import { Checkbox } from '@/components/motion/checkbox'
import { cn } from '@/lib/utils'
import type { AccessibleRepo } from '@/modules/api/repos.infinite'

export function OwnerHeader({
  owner,
  ownerType,
}: {
  owner: string
  ownerType: 'user' | 'org'
}) {
  const Glyph = ownerType === 'org' ? Building2 : User
  return (
    <div className="flex h-full items-center gap-2 border-border border-b bg-popover px-4 font-medium text-[11px] text-muted-foreground">
      <Glyph className="size-3" />
      <span>{owner}</span>
    </div>
  )
}

/**
 * One repository.
 *
 * A button rather than a row with a checkbox in it, so the whole row is the
 * target. At this list length the checkbox alone is a 17px target among a few
 * hundred, which is a miss waiting to happen.
 */
function RepoRow({
  repo,
  selected,
  already,
  onToggle,
}: {
  repo: AccessibleRepo
  selected: boolean
  already: boolean
  onToggle: () => void
}) {
  const [owner, name] = splitRepo(repo.repo)
  const pushed = pushedLabel(repo.pushedAt)
  const stars = starsLabel(repo.stars)
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={already}
      onClick={onToggle}
      className={cn(
        'flex h-full w-full items-center gap-3 px-4 text-left transition-colors',
        already ? 'opacity-45' : 'hover:bg-muted/60',
      )}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={onToggle}
        disabled={already}
        aria-label={repo.repo}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[13px]">
          <span className="text-muted-foreground">{owner}/</span>
          <span className="font-semibold">{name}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          {repo.isPrivate ? <Lock className="size-2.5" /> : null}
          {repo.language === '' ? null : <span>{repo.language}</span>}
          {pushed === '' ? null : <span>{pushed}</span>}
          {stars === '' ? null : <span>{stars}</span>}
        </span>
      </span>
      {already ? (
        <span className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
          <Check className="size-2.5" /> watching
        </span>
      ) : null}
    </button>
  )
}

/** Matches the row it replaces, so nothing shifts when the page arrives. */
export function SkeletonRow() {
  return (
    <div className="flex h-full items-center gap-3 px-4" aria-hidden="true">
      <span className="size-[17px] animate-pulse rounded-[5px] bg-muted" />
      <span className="flex-1">
        <span className="block h-[11px] w-44 animate-pulse rounded bg-muted" />
        <span className="mt-1.5 block h-2 w-24 animate-pulse rounded bg-muted" />
      </span>
    </div>
  )
}

export function renderRow(
  row: PickerRow<AccessibleRepo>,
  selected: ReadonlySet<string>,
  watched: ReadonlySet<string>,
  onToggle: (repo: string) => void,
) {
  if (row.kind === 'header') {
    return <OwnerHeader owner={row.owner} ownerType={row.ownerType} />
  }
  return (
    <RepoRow
      repo={row.repo}
      selected={selected.has(row.repo.repo)}
      already={watched.has(row.repo.repo)}
      onToggle={() => onToggle(row.repo.repo)}
    />
  )
}

function splitRepo(full: string): [string, string] {
  const slash = full.indexOf('/')
  return slash === -1
    ? ['', full]
    : [full.slice(0, slash), full.slice(slash + 1)]
}
