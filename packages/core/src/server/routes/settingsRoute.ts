import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { loadConfig, saveConfig } from '@/config'
import { RUN_POLICIES } from '@/modules/settings/domains'

/**
 * A partial settings write.
 *
 * Every field optional so a client can change one without restating the rest,
 * which is what stops two open windows overwriting each other's unrelated
 * edits.
 */
const patchSchema = z.object({
  pollSeconds: z.number().int().min(10).optional(),
  maxIssuesPerPoll: z.number().int().min(1).optional(),
  staleClaimMinutes: z.number().int().min(1).optional(),
  keepWorktreeOnFailure: z.boolean().optional(),
  defaultPolicy: z.enum(RUN_POLICIES).optional(),
  maxRevisions: z.number().int().min(0).max(5).optional(),
  maxCiFixes: z.number().int().min(0).max(5).optional(),
  turnTimeoutMs: z.number().int().min(1000).optional(),
  trustedAuthorsOnly: z.boolean().optional(),
  requireLabel: z.string().nullable().optional(),
  notifications: z.boolean().optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
  agents: z
    .object({
      analyst: z.string().optional(),
      implementer: z.string().optional(),
      reviewer: z.string().optional(),
    })
    .optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
})

export const settingsRoute = new Hono()
  .get('/settings', async (c) => c.json({ settings: await loadConfig() }))
  .patch('/settings', zValidator('json', patchSchema), async (c) => {
    const patch = c.req.valid('json')
    const current = await loadConfig()
    const next = {
      ...current,
      ...patch,
      agents: { ...current.agents, ...(patch.agents ?? {}) },
    }
    await saveConfig(next)
    return c.json({ settings: next })
  })
