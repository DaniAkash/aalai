import type { InferRequestType, InferResponseType } from 'hono/client'
import { createMutation, createQuery } from 'react-query-kit'
import { api } from '@/modules/api/client'
import { parseResponse } from '@/modules/api/parse'
import { queryClient } from '@/modules/api/queryClient'

type Client = Awaited<ReturnType<typeof api>>
type SettingsResponse = InferResponseType<Client['api']['settings']['$get']>
type SettingsPatch = InferRequestType<
  Client['api']['settings']['$patch']
>['json']

export const useSettings = createQuery<SettingsResponse>({
  queryKey: ['settings'],
  fetcher: async () => {
    const client = await api()
    return parseResponse<SettingsResponse>(await client.api.settings.$get())
  },
})

/**
 * Changes one setting without restating the rest.
 *
 * The route takes a partial for a reason: two windows open on settings would
 * otherwise overwrite each other's unrelated edits every time either saved.
 */
export const useSaveSettings = createMutation<SettingsResponse, SettingsPatch>({
  mutationFn: async (patch) => {
    const client = await api()
    return parseResponse<SettingsResponse>(
      await client.api.settings.$patch({ json: patch }),
    )
  },
  onSettled: () => {
    void queryClient.invalidateQueries({ queryKey: useSettings.getKey() })
  },
})
