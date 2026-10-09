import { useNavigate, useSearch } from '@tanstack/react-router'
import { DEFAULT_MODE, type RunPolicy } from 'aalai/shared'
import { useState } from 'react'
import { useToast } from '@/components/providers/ToastProvider'
import { useQueue } from '@/modules/api/queue.hooks'
import { useWatchedRepos } from '@/modules/api/repos.hooks'
import { useStartWork } from '@/modules/api/startWork.hooks'
import { useWork } from '@/modules/api/work.hooks'

/**
 * Everything the composer needs, and where its state lives.
 *
 * The repository and the mode live in the url rather than in state, so a
 * composer can be linked to already pointed at something. The brief is the one
 * thing that does not: a half written sentence in a url is a draft that
 * survives a refresh by accident rather than on purpose.
 */
export function useNewWork() {
  const navigate = useNavigate()
  const toast = useToast()
  const search = useSearch({ strict: false }) as {
    repo?: string
    mode?: RunPolicy
  }
  const [brief, setBrief] = useState('')

  const repos = useWatchedRepos()
  const queue = useQueue()
  const work = useWork()
  const start = useStartWork({
    onError: (error) => toast.failed('Could not start that', error),
    onSuccess: (started) => {
      setBrief('')
      void navigate({ to: '/work/$workId', params: { workId: started.id } })
    },
  })

  const known: string[] = repos.data?.repos.map((item) => item.repo) ?? []
  const repo = search.repo ?? known[0]
  const mode = search.mode ?? DEFAULT_MODE

  return {
    brief,
    setBrief,
    repo,
    mode,
    repos: known,
    choose: (next: { repo?: string; mode?: RunPolicy }) => {
      void navigate({
        to: '/work/new',
        search: (current) => ({ ...current, ...next }),
      })
    },
    start,
    queue: queue.data ?? null,
    // Work GitHub offered that nobody has started: the composer is also where
    // you look when you do not want to describe anything new.
    waiting:
      work.data?.lanes.find((lane) => lane.key === 'offered')?.items ?? [],
    loading: repos.isPending,
  }
}
