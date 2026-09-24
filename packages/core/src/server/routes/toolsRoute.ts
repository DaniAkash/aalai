import { Hono } from 'hono'
import { resolveToolAccess } from '@/modules/tools/context'
import { handleToolRequest } from '@/modules/tools/server'

/**
 * The tool surface agents call, mounted on the server that already exists.
 *
 * Under /api so the bearer token guard already applies, and the run token in
 * the path is what says which run a call may write to. A station never names
 * its own target, so a poisoned issue body cannot talk one into writing
 * somewhere else.
 */
export const toolsRoute = new Hono().all('/mcp/:runToken', async (c) => {
  const context = resolveToolAccess(c.req.param('runToken'))
  if (context === undefined) {
    return c.json({ error: 'unknown or expired run token' }, 404)
  }
  return await handleToolRequest(c.req.raw, context)
})
