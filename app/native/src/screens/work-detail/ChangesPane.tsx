import { skipToken } from '@tanstack/react-query'
import { languageOf, parsePatch } from 'aalai/shared'
import type { AgentCodeLanguage } from '@/components/agents/agent-code'
import { FileDiff } from '@/components/agents/file-diff'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useChanges, useFilePatch } from '@/modules/api/changes.hooks'

/**
 * What this branch changed, beside the conversation about it.
 *
 * The list is every file and the pane below it is one of them, because a
 * branch can touch forty files and showing all of their patches at once is a
 * scroll nobody reads. Choosing a file is a url, so the view can be sent.
 */
export function ChangesPane({
  workId,
  path,
  onChoose,
}: {
  workId: string
  path: string | null
  onChoose: (path: string | null) => void
}) {
  const changes = useChanges({ variables: { id: workId } })
  const patch = useFilePatch({
    variables: path === null ? skipToken : { id: workId, path },
  })

  if (changes.isPending) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  }

  if (changes.isError || !changes.data || !('files' in changes.data)) {
    return <Note>The changes could not be read.</Note>
  }

  const { files, branch, absent } = changes.data

  if (absent === 'no-branch') {
    return <Note>Nothing has been changed yet, so there is no branch.</Note>
  }
  if (absent === 'no-clone') {
    return (
      <Note>
        This repository is not cloned on this machine, so its changes cannot be
        read here.
      </Note>
    )
  }

  return (
    <div className="flex min-h-0 flex-col">
      <header className="flex items-baseline gap-2 border-border border-b px-4 py-3">
        <h2 className="font-heading font-semibold text-[13px]">Changes</h2>
        <span className="font-mono text-[11px] text-muted-foreground">
          {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
        <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
          {branch}
        </span>
      </header>

      <ul className="flex flex-col gap-px p-2">
        {files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              onClick={() => onChoose(file.path === path ? null : file.path)}
              className={cn(
                'flex w-full items-center gap-2 rounded-[calc(var(--radius)-4px)] px-2 py-1.5 text-left transition-colors',
                file.path === path ? 'bg-secondary' : 'hover:bg-secondary',
              )}
            >
              <Kind kind={file.kind} />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                {file.path}
              </span>
              <Counts added={file.additions} removed={file.deletions} />
            </button>
          </li>
        ))}
      </ul>

      {path === null ? (
        <p className="px-4 pb-4 text-[12.5px] text-muted-foreground">
          Choose a file to read what changed in it.
        </p>
      ) : patch.isPending ? (
        <div className="px-4 pb-4">
          <Skeleton className="h-40 w-full" />
        </div>
      ) : patch.isError || !patch.data ? (
        <Note>That file could not be read.</Note>
      ) : (
        <div className="px-3 pb-4">
          <FileDiff
            file={path}
            language={languageOf(path) as AgentCodeLanguage}
            lines={parsePatch(patch.data.patch).map((line) => ({
              id: line.id,
              // A hunk header is not a change, and colouring it as context
              // would make the file look longer than it is.
              type: line.type === 'meta' ? 'context' : line.type,
              oldLine: line.oldLine,
              newLine: line.newLine,
              content: line.content,
            }))}
            defaultOpen
            maxHeight={520}
            copyText={patch.data.patch}
          />
        </div>
      )}
    </div>
  )
}

function Kind({ kind }: { kind: string }) {
  return (
    <span
      title={kind}
      className="grid size-4 shrink-0 place-items-center rounded border border-border bg-card font-mono font-semibold text-[9px] text-muted-foreground"
    >
      {kind.charAt(0).toUpperCase()}
    </span>
  )
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-[10.5px]">
      {added > 0 ? (
        <span className="text-[color-mix(in_oklab,green_55%,var(--foreground))]">
          +{added}
        </span>
      ) : null}
      {removed > 0 ? (
        <span className="ml-1.5 text-muted-foreground">-{removed}</span>
      ) : null}
    </span>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-6 text-[12.5px] text-muted-foreground">{children}</p>
  )
}
