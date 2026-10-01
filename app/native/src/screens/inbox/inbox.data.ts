import { useOpenGates } from '@/modules/api/gates.hooks'
import { useQueue } from '@/modules/api/queue.hooks'
import { usePastRuns } from '@/modules/api/runs.hooks'

/**
 * Everything the inbox draws, as one object.
 *
 * The screen calls this and nothing else, so what it needs is stated in one
 * place rather than assembled from four hooks in the middle of the markup.
 */
export function useInboxData() {
  const gates = useOpenGates()
  const runs = usePastRuns()
  const queue = useQueue()

  return {
    gates: gates.data?.gates ?? [],
    // What the watcher found and nobody has decided about yet. Nothing has
    // started for any of these, which is the point: the decision is the
    // maintainer's and it is made here.
    offers: (queue.data?.entries ?? []).filter((e) => e.status === 'offered'),
    // What the factory is doing instead, so an empty inbox reads as calm
    // rather than as broken.
    working:
      runs.data?.runs.filter((run) => run.status === 'running').length ?? 0,
    isPending: gates.isPending,
    // Both, because "nothing is waiting" and "0 runs in flight" are claims
    // about two requests, and a screen that makes the second one while the
    // request behind it failed is stating something it does not know.
    isError: gates.isError || runs.isError,
    error: (gates.error ?? runs.error)?.message ?? '',
    retry: () => {
      void gates.refetch()
      void runs.refetch()
      void queue.refetch()
    },
  }
}
