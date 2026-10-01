import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { loadConfig, saveConfig, type WatchedRepo } from '@/config'
import {
  accessibleRepos,
  REPO_PAGE_SIZE,
  repoOwners,
  searchRepos,
} from '@/lib/ghRepos'
import { type RunPolicy, runPolicySchema } from '@/modules/settings/domains'

/**
 * Adding is a batch, and the policy is required rather than optional.
 *
 * A batch because the picker can select several at once, and one request keeps
 * them a single all or nothing change to the config rather than a half applied
 * list if the third one collides.
 *
 * Required because an omitted policy used to mean "inherit the factory
 * default", which is automatic, so a repository could be signed up for
 * unattended pull requests by a decision nobody made or saw.
 */
const addSchema = z.object({
  repos: z
    .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
    .min(1)
    .max(50),
  requireLabel: z.string().optional(),
  policy: runPolicySchema,
})

/**
 * Paging, coerced because a query string carries numbers as text.
 *
 * The ceiling is GitHub's own per-page maximum. Asking for more is not an error
 * there, it is silently truncated, which would make the client believe it had
 * reached the end.
 */
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(REPO_PAGE_SIZE),
})

const searchSchema = pageSchema.extend({ q: z.string().min(1) })

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
  .get('/github/repos', zValidator('query', pageSchema), async (c) => {
    // What the signed in account can actually act on, one page at a time.
    // Unpaged, this answered with whatever the first two hundred happened to
    // be, which on an account in several organizations is a fraction of them.
    const { page, perPage } = c.req.valid('query')
    return c.json(await accessibleRepos(page, perPage))
  })
  .get('/github/repos/search', zValidator('query', searchSchema), async (c) => {
    // Searching runs on GitHub rather than over the pages already loaded,
    // because filtering what has arrived answers a question about the first
    // page rather than about the account.
    const { q, page, perPage } = c.req.valid('query')
    return c.json(await searchRepos(q, page, perPage))
  })
  .get('/github/owners', async (c) => {
    // Asked for separately because the scope selector has to exist before any
    // page of repositories has arrived.
    return c.json({ owners: await repoOwners() })
  })
  .post('/repos', zValidator('json', addSchema), async (c) => {
    const { repos, ...rest } = c.req.valid('json')
    const config = await loadConfig()
    const known = new Set(config.watch.map((w) => w.repo))
    // Already watched ones are skipped rather than rejected. The picker marks
    // them and disables the row, so the only way to send one is a list that
    // went stale mid-pick, and failing the whole batch for that would lose the
    // other nine choices.
    const added = repos
      .filter((repo) => !known.has(repo))
      .map((repo) => ({ repo, ...rest }))
    if (added.length === 0) {
      return c.json({ error: 'already watched' }, 409)
    }
    const next = { ...config, watch: [...config.watch, ...added] }
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
