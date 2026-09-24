import { Hono } from 'hono'
import { z } from 'zod'
import { loadConfig, saveConfig } from '@/config'
import { ownedRepos } from '@/lib/gh'

const addSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  requireLabel: z.string().optional(),
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
  .post('/repos', async (c) => {
    const body = addSchema.safeParse(await c.req.json())
    if (!body.success)
      return c.json({ error: z.prettifyError(body.error) }, 400)

    const config = await loadConfig()
    if (config.watch.some((w) => w.repo === body.data.repo)) {
      return c.json({ error: 'already watched' }, 409)
    }
    const next = { ...config, watch: [...config.watch, body.data] }
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
