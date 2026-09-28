import type { InferRequestType, InferResponseType } from 'hono/client'
import { createMutation, createQuery } from 'react-query-kit'
import { api } from '@/modules/api/client'
import { useGate, useOpenGates } from '@/modules/api/gates.hooks'
import { parseResponse } from '@/modules/api/parse'
import { queryClient } from '@/modules/api/queryClient'

type Client = Awaited<ReturnType<typeof api>>
type ThreadResponse = InferResponseType<
  Client['api']['gates'][':id']['thread']['$get'],
  200
>
type ReplyBody = InferRequestType<
  Client['api']['gates'][':id']['reply']['$post']
>['json']

interface ThreadVars {
  readonly id: string
}

/** Same reason as the gate hooks: Hono's client inserts a path param verbatim. */
function inPath(id: string): string {
  return encodeURIComponent(id)
}

/**
 * The discussion behind a gate.
 *
 * Polled on a floor as well as invalidated by the event stream, because the
 * interesting change here is one this window did not cause: the analyst
 * answering. A dropped connection should degrade to slow rather than to a thread
 * that has stopped moving with no sign that it has.
 */
export const useThread = createQuery<ThreadResponse, ThreadVars>({
  queryKey: ['gates', 'thread'],
  fetcher: async ({ id }) => {
    const client = await api()
    return parseResponse<ThreadResponse>(
      await client.api.gates[':id'].thread.$get({ param: { id: inPath(id) } }),
    )
  },
  refetchInterval: 5_000,
  refetchOnWindowFocus: true,
})

/**
 * Says something at a gate without answering it.
 *
 * No optimistic append. A reply can be refused by a gate somebody else just
 * answered, and a thread that has already drawn the message has lied about what
 * the record says. The refusal is the case worth getting right, since the person
 * still needs their text.
 */
export const useReply = createMutation<unknown, ThreadVars & ReplyBody>({
  mutationFn: async ({ id, ...body }) => {
    const client = await api()
    return parseResponse<unknown>(
      await client.api.gates[':id'].reply.$post({
        param: { id: inPath(id) },
        json: body,
      }),
    )
  },
  onSettled: (_data, _error, vars) => {
    void queryClient.invalidateQueries({
      queryKey: useThread.getKey({ id: vars.id }),
    })
    // The gate itself too: a reply that revised the plan supersedes it, so the
    // row and the artifact on screen both move.
    void queryClient.invalidateQueries({
      queryKey: useGate.getKey({ id: vars.id }),
    })
    void queryClient.invalidateQueries({ queryKey: useOpenGates.getKey() })
  },
})
