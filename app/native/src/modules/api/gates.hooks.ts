import type { InferRequestType, InferResponseType } from 'hono/client'
import { createMutation, createQuery } from 'react-query-kit'
import { api } from '@/modules/api/client'
import { parseResponse } from '@/modules/api/parse'
import { queryClient } from '@/modules/api/queryClient'

type Client = Awaited<ReturnType<typeof api>>
// Narrowed to 200: the route's type union includes the validator's 400 shape,
// and a fetcher that already threw on a bad status never returns it.
type GatesResponse = InferResponseType<Client['api']['gates']['$get'], 200>
type GateResponse = InferResponseType<
  Client['api']['gates'][':id']['$get'],
  200
>
type AnswerBody = InferRequestType<
  Client['api']['gates'][':id']['answer']['$post']
>['json']

interface GateVars {
  readonly id: string
}

/**
 * A gate id inside a URL path.
 *
 * The id carries a slash, a hash and an at sign, and Hono's client puts a path
 * parameter in verbatim. Unencoded, the slash starts a new path segment and
 * the request asks for a gate that does not exist. The router hands these back
 * already decoded, so this is the only place that has to think about it.
 */
function inPath(id: string): string {
  return encodeURIComponent(id)
}

/**
 * What is waiting on a person.
 *
 * The factory opens and answers gates on its own schedule, so an open window
 * has to be told. The event stream does that by invalidating this; the interval
 * is the floor for a dropped connection rather than the mechanism.
 */
export const useOpenGates = createQuery<GatesResponse>({
  queryKey: ['gates'],
  fetcher: async () => {
    const client = await api()
    return parseResponse<GatesResponse>(
      await client.api.gates.$get({ query: { status: 'open' } }),
    )
  },
  refetchInterval: 30_000,
  refetchOnWindowFocus: true,
})

export const useGate = createQuery<GateResponse, GateVars>({
  queryKey: ['gates', 'one'],
  fetcher: async ({ id }) => {
    const client = await api()
    return parseResponse<GateResponse>(
      await client.api.gates[':id'].$get({ param: { id: inPath(id) } }),
    )
  },
})

/**
 * Records a decision.
 *
 * No optimistic update on purpose. The answer can be refused, by a gate that
 * somebody else already answered or whose artifact moved underneath it, and a
 * surface that has already drawn "approved" has lied. The refusal is the
 * interesting case here, not the happy path.
 */
export const useAnswerGate = createMutation<
  unknown,
  GateVars & Omit<AnswerBody, 'answeredOn'>
>({
  mutationFn: async ({ id, ...body }) => {
    const client = await api()
    const response = await client.api.gates[':id'].answer.$post({
      param: { id: inPath(id) },
      json: { ...body, answeredOn: 'app' },
    })
    return parseResponse<unknown>(response)
  },
  onSettled: (_data, _error, vars) => {
    // Only the id, because that is what the detail query was keyed with.
    // Passing the whole of vars builds a key carrying the decision too, which
    // matches nothing. The list invalidation below happens to cover the detail
    // anyway, since ['gates'] is a prefix of it, so this was not broken so much
    // as inert: a line that reads as though it does the work and does not.
    void queryClient.invalidateQueries({
      queryKey: useGate.getKey({ id: vars.id }),
    })
    void queryClient.invalidateQueries({ queryKey: useOpenGates.getKey() })
  },
})
