import type { InferResponseType } from 'hono/client'
import { createMutation, createQuery } from 'react-query-kit'
import { api } from '@/modules/api/client'
import { parseResponse } from '@/modules/api/parse'
import { queryClient } from '@/modules/api/queryClient'

type Client = Awaited<ReturnType<typeof api>>
type QueueResponse = InferResponseType<Client['api']['queue']['$get'], 200>

/**
 * One row of the queue.
 *
 * Spelled out from the client rather than through the response alias, so an
 * exported type never depends on a private one.
 */
export type QueueEntry = InferResponseType<
  Awaited<ReturnType<typeof api>>['api']['queue']['$get'],
  200
>['entries'][number]

type SubjectKind = QueueEntry['kind']

/**
 * The queue, and how much of the machine it is allowed to use.
 *
 * Polled rather than streamed. The event bus is keyed per run and a slot
 * freeing belongs to no run, so the capacity would have had to be squeezed
 * into a shape it does not fit.
 */
export const useQueue = createQuery<QueueResponse>({
  queryKey: ['queue'],
  fetcher: async () => {
    const client = await api()
    return parseResponse<QueueResponse>(
      await client.api.queue.$get({ query: {} }),
    )
  },
  refetchInterval: 4000,
})

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: useQueue.getKey() })
}

interface Subject {
  repo: string
  kind: SubjectKind
  number: number
}

const parts = (subject: Subject) => {
  const [owner, name] = subject.repo.split('/')
  return {
    owner: owner as string,
    name: name as string,
    kind: subject.kind,
    number: String(subject.number),
  }
}

export const useQueueRun = createMutation<unknown, Subject>({
  mutationFn: async (subject) => {
    const client = await api()
    return parseResponse(
      await client.api.queue[':owner'][':name'][':kind'][':number'].$post({
        param: parts(subject),
      }),
    )
  },
  onSettled: refresh,
})

export const useDismissRun = createMutation<unknown, Subject>({
  mutationFn: async (subject) => {
    const client = await api()
    return parseResponse(
      await client.api.queue[':owner'][':name'][':kind'][':number'].$delete({
        param: parts(subject),
      }),
    )
  },
  onSettled: refresh,
})

export const useStartRun = createMutation<unknown, Subject>({
  mutationFn: async (subject) => {
    const client = await api()
    return parseResponse(
      await client.api.queue[':owner'][':name'][':kind'][':number'].start.$post(
        {
          param: parts(subject),
        },
      ),
    )
  },
  onSettled: refresh,
})

export const usePauseQueue = createMutation<unknown, { paused: boolean }>({
  mutationFn: async (vars) => {
    const client = await api()
    return parseResponse(await client.api.queue.pause.$post({ json: vars }))
  },
  onSettled: refresh,
})
