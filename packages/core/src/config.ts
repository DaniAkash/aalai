import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'

const watchedRepoSchema = z.object({
  /** `owner/repo`, matching GitHub's canonical casing. */
  repo: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/),
})

export const configSchema = z.object({
  /**
   * Refused rather than ignored. This was replaced by `agents`, and zod would
   * otherwise strip it, so a config asking for a non-codex agent would silently
   * run codex for every station.
   */
  agent: z
    .never({ error: 'the `agent` key was replaced by `agents`: { analyst, implementer, reviewer }' })
    .optional(),
  pollSeconds: z.number().int().min(10).default(60),
  watch: z.array(watchedRepoSchema).min(1),
  /**
   * Which ACP agent drives each station.
   *
   * All three default to codex so a demo machine needs one agent installed and
   * authenticated, and the pipeline threads them through per station.
   *
   * TODO: point `reviewer` at a different agent (`claude`, `gemini`, whatever
   * acpx can reach) to get genuine cross-vendor review. That buys a different
   * harness, different tools, and a different system prompt written by a
   * different company, rather than the same model grading its own idiom. It is
   * a config change and nothing else: no code here assumes one agent.
   */
  agents: z
    .object({
      analyst: z.string().default('codex'),
      implementer: z.string().default('codex'),
      reviewer: z.string().default('codex'),
    })
    .default(() => ({ analyst: 'codex', implementer: 'codex', reviewer: 'codex' })),
  /** Most times the reviewer may send work back before the run gives up. */
  maxRevisions: z.number().int().min(0).max(5).default(2),
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
  /** Commit author name and email. Passed per-commit, never read from global git config. */
  commitName: z.string().default('aalai'),
  commitEmail: z.string().default('DaniAkash@users.noreply.github.com'),
  /**
   * How long a run may hold its claim before another poll may take it over.
   * A process killed mid-run would otherwise leave the issue claimed forever.
   */
  staleClaimMinutes: z.number().int().min(1).default(30),
  /** Most issues one polling pass will process. The rest wait for the next pass. */
  maxIssuesPerPoll: z.number().int().min(1).default(25),
  /** Port for the dashboard and its API. */
  uiPort: z.number().int().min(1024).max(65535).default(4173),
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

/**
 * Where a config may live, in the order we look.
 *
 * The working directory comes first so running this in a terminal behaves as
 * it always has. The state directory is the fallback because the desktop shell
 * spawns the factory with whatever working directory the app happened to have,
 * which is not somewhere a person would keep a config file.
 */
export function configCandidates(path?: string): string[] {
  if (path) return [resolve(path)]
  const fromEnv = process.env.AALAI_CONFIG
  return [
    ...(fromEnv ? [resolve(fromEnv)] : []),
    resolve(DEFAULT_CONFIG_PATH),
    join(stateDir(), DEFAULT_CONFIG_PATH),
  ]
}

export async function loadConfig(path?: string): Promise<Config> {
  const candidates = configCandidates(path)
  let file: ReturnType<typeof Bun.file> | undefined
  for (const candidate of candidates) {
    const at = Bun.file(candidate)
    if (await at.exists()) {
      file = at
      break
    }
  }
  if (!file) {
    throw new Error(
      `No config found. Looked in:\n${candidates.map((c) => `  ${c}`).join('\n')}\nCopy aalai.config.example.json to one of them and edit it.`,
    )
  }
  const parsed = configSchema.safeParse(await file.json())
  if (!parsed.success) {
    throw new Error(`Invalid config at ${file.name}:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}
