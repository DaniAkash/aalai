import { z } from 'zod'

/**
 * Settings grouped into domains, one row each.
 *
 * A domain is the unit that is read, validated and fallen back on, so a
 * corrupt agents row cannot stop the factory from knowing how often to poll.
 * Adding a setting is a change to one of these objects and needs no migration,
 * which is the point of storing the value as JSON.
 *
 * These shapes are also where Config gets its fields, so a default is written
 * once and the stored form and the loaded form cannot disagree.
 */

const factoryDomain = z.object({
  pollSeconds: z.number().int().min(10).default(60),
  /** Most issues one polling pass will process. The rest wait for the next pass. */
  maxIssuesPerPoll: z.number().int().min(1).default(25),
  /**
   * How long a run may hold its claim before another poll may take it over.
   * A process killed mid-run would otherwise leave the issue claimed forever.
   */
  staleClaimMinutes: z.number().int().min(1).default(30),
  keepWorktreeOnFailure: z.boolean().default(true),
})

const agentsDomain = z.object({
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
   * a settings change and nothing else: no code here assumes one agent.
   */
  analyst: z.string().default('codex'),
  implementer: z.string().default('codex'),
  reviewer: z.string().default('codex'),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).default('high'),
})

const limitsDomain = z.object({
  /** Most times the reviewer may send work back before the run gives up. */
  maxRevisions: z.number().int().min(0).max(5).default(2),
  /** Read once a failing check is retried automatically. Stored now so the
   * setting does not have to arrive alongside the behaviour. */
  maxCiFixes: z.number().int().min(0).max(5).default(2),
  turnTimeoutMs: z.number().int().min(60_000).default(900_000),
})

const trustDomain = z.object({
  /**
   * When true, only issues opened by an OWNER, MEMBER, or COLLABORATOR start a
   * run. An issue body is instructions to an agent with file and shell access,
   * and on a public repo anyone can write one. Turning this off is deliberate.
   */
  trustedAuthorsOnly: z.boolean().default(true),
  /** The default label gate. A watched repository may override it. */
  requireLabel: z.string().nullable().default(null),
})

const commitDomain = z.object({
  /** Commit author, passed per commit and never read from global git config. */
  commitName: z.string().default('aalai'),
  commitEmail: z.string().default('DaniAkash@users.noreply.github.com'),
})

const uiDomain = z.object({
  /** Port for the dashboard and its API. */
  uiPort: z.number().int().min(1024).max(65535).default(4173),
  notifications: z.boolean().default(true),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
})

export const DOMAINS = {
  factory: factoryDomain,
  agents: agentsDomain,
  limits: limitsDomain,
  trust: trustDomain,
  commit: commitDomain,
  ui: uiDomain,
} as const

export type DomainName = keyof typeof DOMAINS
export type Domains = {
  [K in DomainName]: z.infer<(typeof DOMAINS)[K]>
}

export const DOMAIN_NAMES = Object.keys(DOMAINS) as DomainName[]
