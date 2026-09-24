import { hc } from 'hono/client'
import type { app } from '@/server/app'

/**
 * The typed client, instantiated once here rather than at every call site.
 *
 * Hono's guide is explicit that instantiating `hc<AppType>` in the consumer
 * makes tsserver re-derive every route's types on each use, and that this gets
 * worse with each route added. Doing it once lets tsc pay that cost at compile
 * time and hands the consumer a plain type.
 *
 * This module imports the runtime app, so it must never be reached from a
 * browser bundle's component tree: one importer, the client module, and no
 * other.
 */
const client = hc<typeof app>('')

export type Client = typeof client

export const hcWithType = (...args: Parameters<typeof hc>): Client =>
  hc<typeof app>(...args)
