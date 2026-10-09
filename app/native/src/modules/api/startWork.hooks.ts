import type { RunPolicy } from 'aalai/shared'
import { createMutation } from 'react-query-kit'
import { api } from '@/modules/api/client'
import { parseResponse } from '@/modules/api/parse'
import { queryClient } from '@/modules/api/queryClient'
import { useQueue } from '@/modules/api/queue.hooks'
import { useWork } from '@/modules/api/work.hooks'

/** What the factory did with a brief, which is not always what was asked for. */
interface StartedWork {
  readonly id: string
  readonly repo: string
  readonly number: number
  readonly title: string
  readonly url: string
  /** False when every slot was taken and it is waiting in line. */
  readonly started: boolean
}

interface StartWorkVars {
  readonly repo: string
  readonly brief: string
  readonly mode: RunPolicy
}

export const useStartWork = createMutation<StartedWork, StartWorkVars>({
  mutationFn: async (vars) => {
    const client = await api()
    return parseResponse<StartedWork>(
      await client.api.work.$post({
        json: { repo: vars.repo, brief: vars.brief, mode: vars.mode },
      }),
    )
  },
  onSuccess: () => {
    // Both: the new row belongs in the list, and a claimed slot changes the
    // advisory the composer itself is showing.
    void queryClient.invalidateQueries({ queryKey: useWork.getKey() })
    void queryClient.invalidateQueries({ queryKey: useQueue.getKey() })
  },
})
