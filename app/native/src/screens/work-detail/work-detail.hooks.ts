import { skipToken } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { useToast } from '@/components/providers/ToastProvider'
import { useAnswerGate } from '@/modules/api/gates.hooks'
import { queryClient } from '@/modules/api/queryClient'
import { useQueue } from '@/modules/api/queue.hooks'
import { useArtifact, useWorkDetail } from '@/modules/api/workDetail.hooks'
import { useStepActivity } from '@/modules/live/useStepActivity'

/**
 * Everything one thread screen needs, resolved in one place.
 *
 * Five sources have to agree before anything can be drawn: the thread, the
 * live activity, the queue, the open artifact and the url. Resolving them in
 * the component put a dozen branches in front of the first element it renders.
 */
export function useWorkDetailScreen() {
  const { workId } = useParams({ strict: false }) as { workId: string }
  const navigate = useNavigate()
  const toast = useToast()
  const [open, setOpen] = useState<string | null>(null)

  // The chosen file lives in the url rather than in state, so the pane can be
  // linked to. Everything after `/changes/` is the path, slashes included.
  const path = useLocation({
    select: (location) => decodeOrNull(location.pathname.split('/changes/')[1]),
  })

  const detail = useWorkDetail({ variables: { id: workId } })
  const artifact = useArtifact({
    variables: open === null ? skipToken : { id: workId, artifact: open },
  })
  const item = detail.data && 'item' in detail.data ? detail.data.item : null
  const activity = useStepActivity(
    item === null ? null : { repo: item.repo, number: item.number },
  )
  const queue = useQueue()
  const answer = useAnswerGate({
    onError: (error) => toast.failed('Could not record that answer', error),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: useWorkDetail.getKey() })
    },
  })

  return {
    workId,
    detail,
    activity,
    answer,
    path,
    open,
    artifactBody: artifact.data?.body,
    slot: queue.data
      ? { running: queue.data.running, capacity: queue.data.capacity }
      : null,
    toggleArtifact: (artifactId: string) =>
      setOpen(open === artifactId ? null : artifactId),
    chooseFile: (next: string | null) => {
      void navigate({
        to: next === null ? '/work/$workId' : '/work/$workId/changes/$',
        params: next === null ? { workId } : { workId, _splat: next },
      })
    },
  }
}

/**
 * A url path segment, as the path it names.
 *
 * A file path arrives percent encoded and a malformed escape throws rather
 * than returning something wrong, so a bad link opens the thread with no file
 * instead of a blank screen.
 */
function decodeOrNull(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') {
    return null
  }
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}
