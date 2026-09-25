import { hc } from 'hono/client'
import type { AppType } from '@/server/app'

/**
 * The typed client, instantiated once here rather than at every call site.
 *
 * Hono's guide is explicit that instantiating `hc<AppType>` in the consumer
 * makes tsserver re-derive every route's types on each use, and that this gets
 * worse with each route added. Doing it once lets tsc pay that cost at compile
 * time and hands the consumer a plain type.
 *
 * The contract is imported as a type only, so none of the server reaches a
 * browser bundle: `AppType` is erased at compile time and what ships is `hc`
 * plus a base URL. That is what lets the web build use the same client as the
 * desktop one.
 */
const client = hc<AppType>('')

export type Client = typeof client

export const hcWithType = (...args: Parameters<typeof hc>): Client =>
  hc<AppType>(...args)
