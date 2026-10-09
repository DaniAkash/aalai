import type { StationName } from 'aalai/shared'
import { useToast } from '@/components/providers/ToastProvider'
import { useQueue } from '@/modules/api/queue.hooks'
import { useSaveSettings, useSettings } from '@/modules/api/settings.hooks'

/**
 * The settings this screen owns, and how it saves them.
 *
 * Every control saves on its own rather than behind one Save button, which is
 * why the patch is per field: two controls changed quickly must not have the
 * second overwrite the first's unrelated edit.
 */
export function useStations() {
  const toast = useToast()
  const settings = useSettings()
  const queue = useQueue()
  const update = useSaveSettings({
    onError: (error) => toast.failed('Could not save that', error),
  })

  return {
    settings: settings.data?.settings ?? null,
    queue: queue.data ?? null,
    loading: settings.isPending,
    failed: settings.isError,
    retry: () => settings.refetch(),
    saving: update.isPending,
    setCeiling: (maxParallelRuns: number) => update.mutate({ maxParallelRuns }),
    setPaused: (queuePaused: boolean) => update.mutate({ queuePaused }),
    setStation: (
      name: StationName,
      change: {
        skills?: string[]
        instructions?: string
        reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
      },
    ) => update.mutate({ stations: { [name]: change } }),
    setAgent: (name: 'analyst' | 'implementer' | 'reviewer', agent: string) =>
      update.mutate({ agents: { [name]: agent } }),
  }
}
