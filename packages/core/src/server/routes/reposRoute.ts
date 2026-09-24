import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { loadConfig, saveConfig, type WatchedRepo } from '@/config'
import { ownedRepos } from '@/lib/gh'
import { type RunPolicy, runPolicySchema } from '@/modules/settings/domains'

const addSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  requireLabel: z.string().optional(),
  policy: runPolicySchema.optional(),
})

/** Every field optional so changing a policy does not restate the label. */
const patchSchema = z.object({
  requireLabel: z.string().nullable().optional(),
  policy: runPolicySchema.optional(),
})

/**
 * Watched repositories, owned by the app rather than by a text editor.
 *
 * This is the route that makes the desktop app worth having: adding a repo is
 * a click, not a hand edited JSON file in a directory you have to know about.
 */
export const reposRoute = new Hono()
  .get('/repos', async (c) => {
    const config = await loadConfig()
    return c.json({ repos: config.watch })
  })
  .get('/github/repos', async (c) => {
    // What the signed in gh account can actually act on, so the picker offers
    // real choices instead of a free text field and a hope.
    return c.json({ repos: await ownedRepos() })
  })
  .post('/repos', zValidator('json', addSchema), async (c) => {
    const body = c.req.valid('json')
    const config = await loadConfig()
    if (config.watch.some((w) => w.repo === body.repo)) {
      return c.json({ error: 'already watched' }, 409)
    }
    const next = { ...config, watch: [...config.watch, body] }
    await saveConfig(next)
    return c.json({ repos: next.watch })
  })
  .patch('/repos/:owner/:name', zValidator('json', patchSchema), async (c) => {
    const repo = `${c.req.param('owner')}/${c.req.param('name')}`
    const patch = c.req.valid('json')
    const config = await loadConfig()
    const watched = config.watch.find((w) => w.repo === repo)
    if (watched === undefined) {
      return c.json({ error: 'not watched' }, 404)
    }
    const next = {
      ...config,
      watch: config.watch.map((w) =>
        w.repo === repo ? applyPatch(w, patch) : w,
      ),
    }
    await saveConfig(next)
    return c.json({ repos: next.watch })
  })
  .delete('/repos/:owner/:name', async (c) => {
    const repo = `${c.req.param('owner')}/${c.req.param('name')}`
    const config = await loadConfig()
    const next = {
      ...config,
      watch: config.watch.filter((w) => w.repo !== repo),
    }
    await saveConfig(next)
    return c.json({ repos: next.watch })
  })

/**
 * Merges a patch, treating an explicit null as "clear this".
 *
 * The wire form needs null to mean removal, because omitting the key already
 * means "leave it alone". The stored form has no null, so the two are
 * reconciled here rather than by widening the config.
 */
function applyPatch(
  watched: WatchedRepo,
  patch: { requireLabel?: string | null; policy?: RunPolicy },
): WatchedRepo {
  const { requireLabel, ...rest } = watched
  return {
    ...rest,
    ...(patch.policy === undefined ? {} : { policy: patch.policy }),
    ...(patch.requireLabel === undefined
      ? requireLabel === undefined
        ? {}
        : { requireLabel }
      : patch.requireLabel === null
        ? {}
        : { requireLabel: patch.requireLabel }),
  }
}
