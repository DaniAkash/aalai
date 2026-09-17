import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'

const watchedRepoSchema = z.object({
  /** `owner/repo`, matching GitHub's canonical casing. */
  repo: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/),
})

export const configSchema = z.object({
  pollSeconds: z.number().int().min(10).default(60),
  watch: z.array(watchedRepoSchema).min(1),
  agent: z.string().default('codex'),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).default('high'),
  /**
   * When true, only issues opened by an OWNER, MEMBER, or COLLABORATOR start a run.
   * An issue body is instructions to an agent with file and shell access, and on a
   * public repo anyone can write one. Turning this off is a deliberate choice.
   */
  trustedAuthorsOnly: z.boolean().default(true),
  /** Optional second gate: only act on issues carrying this label. */
  requireLabel: z.string().nullable().default(null),
  turnTimeoutMs: z.number().int().min(60_000).default(900_000),
  keepWorktreeOnFailure: z.boolean().default(true),
  /** Commit author email. Defaults to the GitHub noreply address. */
  commitEmail: z.string().default('DaniAkash@users.noreply.github.com'),
})

export type Config = z.infer<typeof configSchema>
export type WatchedRepo = z.infer<typeof watchedRepoSchema>

export const DEFAULT_CONFIG_PATH = 'aalai.config.json'

export function stateDir(): string {
  return process.env.AALAI_STATE_DIR ?? join(homedir(), '.aalai')
}

export function workbenchDir(): string {
  return process.env.AALAI_WORKBENCH_DIR ?? join(homedir(), 'workbench')
}

export async function loadConfig(path = DEFAULT_CONFIG_PATH): Promise<Config> {
  const file = Bun.file(resolve(path))
  if (!(await file.exists())) {
    throw new Error(`No config at ${resolve(path)}. Copy aalai.config.example.json and edit it.`)
  }
  const parsed = configSchema.safeParse(await file.json())
  if (!parsed.success) {
    throw new Error(`Invalid config at ${path}:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}
