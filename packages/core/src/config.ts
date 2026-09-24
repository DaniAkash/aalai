import { renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { configOverride, stateDir } from '@/lib/env'
import { logger } from '@/lib/log'
import { getDb } from '@/modules/db/db'
import { DOMAINS, type Domains } from '@/modules/settings/domains'
import {
  readAllDomains,
  readWatchedRepos,
  settingsAreEmpty,
  writeAllDomains,
  writeWatchedRepos,
} from '@/modules/settings/settings'

const log = logger('config')

const watchedRepoSchema = z.object({
  /** `owner/repo`, matching GitHub's canonical casing. */
  repo: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/),
  /** Per repo label gate, overriding the global default when set. */
  requireLabel: z.string().optional(),
})

/**
 * The flat shape every caller already reads.
 *
 * Built from the domain shapes rather than restating them, so a default lives
 * in exactly one place and the stored form cannot drift from the loaded one.
 * Only `agents` differs: it nests the three agent names, while the domain keeps
 * them alongside the reasoning effort they share a row with.
 */
const configSchema = z.object({
  /**
   * Refused rather than ignored. This was replaced by `agents`, and zod would
   * otherwise strip it, so a config asking for a non-codex agent would silently
   * run codex for every station.
   */
  agent: z
    .never({
      error:
        'the `agent` key was replaced by `agents`: { analyst, implementer, reviewer }',
    })
    .optional(),
  /**
   * Repos to watch. Empty is valid and is what a fresh install looks like:
   * the app adds repos through its own interface rather than asking a person
   * to write JSON before anything will start.
   */
  watch: z.array(watchedRepoSchema).default([]),
  ...DOMAINS.factory.shape,
  ...DOMAINS.limits.shape,
  ...DOMAINS.trust.shape,
  ...DOMAINS.commit.shape,
  ...DOMAINS.ui.shape,
  agents: z
    .object({
      analyst: DOMAINS.agents.shape.analyst,
      implementer: DOMAINS.agents.shape.implementer,
      reviewer: DOMAINS.agents.shape.reviewer,
    })
    .default(() => ({
      analyst: 'codex',
      implementer: 'codex',
      reviewer: 'codex',
    })),
  reasoningEffort: DOMAINS.agents.shape.reasoningEffort,
})

export type Config = z.infer<typeof configSchema>
export type WatchedRepo = z.infer<typeof watchedRepoSchema>

const DEFAULT_CONFIG_PATH = 'aalai.config.json'

/**
 * A config file is now an explicit override, not the store.
 *
 * Settings live in the database so the app can own them, but pointing
 * AALAI_CONFIG at a checked in file stays a legitimate way to run this
 * headless on a server, where the settings are part of the deployment.
 */
function overridePath(path?: string): string | undefined {
  if (path !== undefined) {
    return resolve(path)
  }
  const fromEnv = configOverride()
  return fromEnv === undefined ? undefined : resolve(fromEnv)
}

function toConfig(domains: Domains, watch: WatchedRepo[]): Config {
  return configSchema.parse({
    watch,
    pollSeconds: domains.factory.pollSeconds,
    maxIssuesPerPoll: domains.factory.maxIssuesPerPoll,
    staleClaimMinutes: domains.factory.staleClaimMinutes,
    keepWorktreeOnFailure: domains.factory.keepWorktreeOnFailure,
    agents: {
      analyst: domains.agents.analyst,
      implementer: domains.agents.implementer,
      reviewer: domains.agents.reviewer,
    },
    reasoningEffort: domains.agents.reasoningEffort,
    maxRevisions: domains.limits.maxRevisions,
    maxCiFixes: domains.limits.maxCiFixes,
    turnTimeoutMs: domains.limits.turnTimeoutMs,
    trustedAuthorsOnly: domains.trust.trustedAuthorsOnly,
    requireLabel: domains.trust.requireLabel,
    commitName: domains.commit.commitName,
    commitEmail: domains.commit.commitEmail,
    uiPort: domains.ui.uiPort,
    notifications: domains.ui.notifications,
    theme: domains.ui.theme,
  })
}

function toDomains(config: Config): Domains {
  return {
    factory: {
      pollSeconds: config.pollSeconds,
      maxIssuesPerPoll: config.maxIssuesPerPoll,
      staleClaimMinutes: config.staleClaimMinutes,
      keepWorktreeOnFailure: config.keepWorktreeOnFailure,
    },
    agents: {
      analyst: config.agents.analyst,
      implementer: config.agents.implementer,
      reviewer: config.agents.reviewer,
      reasoningEffort: config.reasoningEffort,
    },
    limits: {
      maxRevisions: config.maxRevisions,
      maxCiFixes: config.maxCiFixes,
      turnTimeoutMs: config.turnTimeoutMs,
    },
    trust: {
      trustedAuthorsOnly: config.trustedAuthorsOnly,
      requireLabel: config.requireLabel,
    },
    commit: {
      commitName: config.commitName,
      commitEmail: config.commitEmail,
    },
    ui: {
      uiPort: config.uiPort,
      notifications: config.notifications,
      theme: config.theme,
    },
  }
}

async function readConfigFile(path: string): Promise<Config> {
  const parsed = configSchema.safeParse(await Bun.file(path).json())
  if (!parsed.success) {
    throw new Error(
      `Invalid config at ${path}:\n${z.prettifyError(parsed.error)}`,
    )
  }
  return parsed.data
}

/**
 * Brings a pre-database config file in, once.
 *
 * The file is renamed rather than deleted: a rename is reversible and a delete
 * is a support ticket. Import only happens into empty settings, so editing the
 * renamed file has no effect and cannot silently undo a change made in the app.
 */
async function importConfigFileOnce(
  db: ReturnType<typeof getDb>,
): Promise<void> {
  if (!settingsAreEmpty(db.sqlite)) {
    return
  }
  const candidates = [
    resolve(DEFAULT_CONFIG_PATH),
    join(stateDir(), DEFAULT_CONFIG_PATH),
  ]
  for (const candidate of candidates) {
    if (!(await Bun.file(candidate).exists())) {
      continue
    }
    const config = await readConfigFile(candidate)
    // One transaction, so the settings that decide whether an import already
    // happened cannot be left half written. Stopping partway would otherwise
    // make the next start see non-empty settings, skip the import, and strand
    // the rest of the file forever.
    db.sqlite.transaction(() => {
      writeAllDomains(db.sqlite, toDomains(config))
      writeWatchedRepos(db.sqlite, config.watch)
    })()
    // After the commit. Stopping between the two leaves the file in place with
    // the import already complete, which is untidy and harmless: the next start
    // finds settings and leaves the file alone.
    renameSync(candidate, `${candidate}.imported`)
    log.info('config file imported into settings', {
      from: candidate,
      repos: config.watch.length,
    })
    return
  }
}

export async function loadConfig(path?: string): Promise<Config> {
  const override = overridePath(path)
  if (override !== undefined) {
    return await readConfigFile(override)
  }
  const db = getDb()
  await importConfigFileOnce(db)
  return toConfig(readAllDomains(db.sqlite), readWatchedRepos(db.sqlite))
}

/**
 * Persists a config.
 *
 * Validated before it is written, so a bad request cannot leave settings that
 * the next start refuses to read.
 */
export async function saveConfig(config: Config): Promise<void> {
  const parsed = configSchema.parse(config)
  const override = overridePath()
  if (override !== undefined) {
    await Bun.write(override, `${JSON.stringify(parsed, null, 2)}\n`)
    return
  }
  const db = getDb()
  writeAllDomains(db.sqlite, toDomains(parsed))
  writeWatchedRepos(db.sqlite, parsed.watch)
}
