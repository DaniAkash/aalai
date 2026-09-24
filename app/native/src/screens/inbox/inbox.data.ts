import { useOpenGates } from '@/modules/api/gates.hooks'
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

  return {
    gates: gates.data?.gates ?? [],
    // What the factory is doing instead, so an empty inbox reads as calm
    // rather than as broken.
    working:
      runs.data?.runs.filter((run) => run.status === 'claimed').length ?? 0,
    isPending: gates.isPending,
    // Both, because "nothing is waiting" and "0 runs in flight" are claims
    // about two requests, and a screen that makes the second one while the
    // request behind it failed is stating something it does not know.
    isError: gates.isError || runs.isError,
    error: (gates.error ?? runs.error)?.message ?? '',
    retry: () => {
      void gates.refetch()
      void runs.refetch()
    },
  }
}
