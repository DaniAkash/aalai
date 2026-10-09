import { Link } from '@tanstack/react-router'
import { WORK_MODES } from 'aalai/shared'
import { GitBranch, Play } from 'lucide-react'
import { PromptInput } from '@/components/agents/prompt-input'
import { ErrorNote } from '@/components/state'
import { Skeleton } from '@/components/ui/skeleton'
import { GithubMark } from '@/components/ui/svgs/github'
import { CapacityAdvice, ModeLabel } from './new-work.components'
import { useNewWork } from './new-work.hooks'

/**
 * Describing a piece of work, and what will happen when you do.
 *
 * One field and one decision. The decision is what the stations will and will
 * not do, which is the only thing here a person cannot change afterwards, so
 * it sits next to the send button rather than behind a settings page.
 */
export function NewWork() {
  const {
    brief,
    setBrief,
    repo,
    mode,
    repos,
    choose,
    start,
    queue,
    waiting,
    loading,
  } = useNewWork()

  if (loading) {
    return <NewWorkSkeleton />
  }
  if (repo === undefined) {
    return (
      <div className="mx-auto w-full max-w-[760px] px-4 py-10 md:px-6">
        <ErrorNote message="Add a repository before starting work on one." />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[760px] px-4 py-8 md:px-6">
      <h1 className="font-heading font-semibold text-[24px] leading-tight tracking-tight">
        What do you want built?
      </h1>
      <p className="mt-1.5 mb-5 max-w-[56ch] text-[13.5px] text-muted-foreground">
        Describe it the way you would to a colleague who has not seen the
        repository. The stations read AGENTS.md, CONTRIBUTING.md and README.md
        before they start.
      </p>

      <PromptInput
        value={brief}
        onValueChange={setBrief}
        minRows={4}
        maxRows={14}
        aria-label="What do you want built?"
        placeholder="The add-repo picker only lists repositories I own. I want it to reach anything the account can see, including the ones I only collaborate on."
        models={WORK_MODES.map((option) => ({
          value: option.policy,
          label: <ModeLabel mode={option} />,
        }))}
        model={mode}
        onModelChange={(next) => choose({ mode: next as typeof mode })}
        loading={start.isPending}
        leadingAction={<RepoChip repo={repo} repos={repos} onChoose={choose} />}
        onSubmit={(value) => {
          const written = value.trim()
          if (written !== '') {
            start.mutate({ repo, brief: written, mode })
          }
        }}
      />

      <CapacityAdvice queue={queue} />

      {waiting.length === 0 ? null : (
        <section className="mt-8">
          <h2 className="font-semibold text-[14px]">
            Found on GitHub, not started
          </h2>
          <p className="mt-1 mb-3 text-[13px] text-muted-foreground">
            aalai watches the repositories you added. Nothing runs until you say
            so.
          </p>
          <div className="overflow-hidden rounded-[var(--radius)] border border-border">
            {waiting.map((item) => (
              <Link
                key={item.id}
                to="/work/$workId"
                params={{ workId: item.id }}
                className="flex items-center gap-3 border-border border-b bg-card px-4 py-3 text-left last:border-b-0 hover:bg-secondary/50"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-secondary">
                  <GithubMark className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px]">
                    {item.title}
                  </span>
                  <span className="mt-0.5 block font-mono text-[11.5px] text-muted-foreground">
                    {item.repo} · {item.kind} #{item.number}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12.5px]">
                  <Play className="size-3" />
                  Open
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/**
 * Which repository this is for.
 *
 * A chip rather than a labelled field: with one repository it is a statement
 * and with several it is a choice, and neither deserves a form row above the
 * thing a person actually came here to write.
 */
function RepoChip({
  repo,
  repos,
  onChoose,
}: {
  repo: string
  repos: readonly string[]
  onChoose: (next: { repo: string }) => void
}) {
  if (repos.length < 2) {
    return (
      <span className="flex items-center gap-1.5 px-1 font-mono text-[12px] text-muted-foreground">
        <GitBranch className="size-3.5" />
        {repo}
      </span>
    )
  }
  return (
    <label className="flex items-center gap-1.5 px-1 font-mono text-[12px] text-muted-foreground">
      <GitBranch className="size-3.5" />
      <span className="sr-only">Repository</span>
      <select
        value={repo}
        onChange={(event) => onChoose({ repo: event.target.value })}
        className="cursor-pointer appearance-none bg-transparent font-mono text-[12px] outline-none"
      >
        {repos.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  )
}

function NewWorkSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[760px] px-4 py-8 md:px-6">
      <Skeleton className="h-7 w-[46%]" />
      <Skeleton className="mt-3 h-4 w-[70%]" />
      <Skeleton className="mt-6 h-[140px] w-full rounded-[var(--radius)]" />
    </div>
  )
}
