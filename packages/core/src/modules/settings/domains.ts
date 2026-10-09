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

/**
 * How much of a run happens without a person.
 *
 * Per repository rather than global, because a toy repository and the day job
 * should never share this setting. `automatic` is the default so an existing
 * installation behaves exactly as it did until somebody opts in.
 */
export const RUN_POLICIES = [
  'automatic',
  'plan_gate',
  'talk',
  'triage',
] as const
export type RunPolicy = (typeof RUN_POLICIES)[number]
export const runPolicySchema = z.enum(RUN_POLICIES)

const factoryDomain = z.object({
  pollSeconds: z.number().int().min(10).default(60),
  /** Most issues one polling pass will process. The rest wait for the next pass. */
  maxIssuesPerPoll: z.number().int().min(1).default(25),
  /**
   * How long a run may hold its claim before another poll may take it over.
   * A process killed mid-run would otherwise leave the issue claimed forever.
   */
  /**
   * How many runs may hold a slot at once.
   *
   * Each one drives a coding agent and a checkout, and this is a laptop. Two
   * rather than one by default, because one long run would otherwise block
   * everything behind it. Four is the ceiling: past that they compete for the
   * same disk and network rather than going faster.
   */
  maxParallelRuns: z.number().int().min(1).max(4).default(2),
  /** Stops promotion without stopping what is already running. */
  queuePaused: z.boolean().default(false),
  staleClaimMinutes: z.number().int().min(1).default(30),
  keepWorktreeOnFailure: z.boolean().default(true),
  /** The default a watched repository inherits when it sets no policy. */
  defaultPolicy: runPolicySchema.default('automatic'),
  /**
   * Whether a delivered pull request is then kept alive.
   *
   * On means a run does not end when the pull request opens: checks, review
   * comments and the base are watched, and a failure the change caused is
   * fixed. Off means delivery is the end, which is what every version before
   * this did.
   *
   * A repository may override it, because the answer differs by how closely
   * somebody is watching the repository rather than by preference.
   */
  keepPullRequestsAlive: z.boolean().default(true),
  /**
   * Whether running somebody's code requires their commits to be signed.
   *
   * On by default, because an author email is a field anybody can set to a
   * trusted account's public address, and a login resolved from one is
   * attribution rather than proof.
   *
   * It is a setting rather than a rule because of what it costs when nobody
   * signs. Most commits in most repositories are unsigned, so leaving this on
   * means every pull request waits for a person, which is safe and is not the
   * same as the contributor path working. Turning it off says: on this
   * repository, write access is the trust boundary and I accept that an email is
   * what links a commit to an account.
   */
  requireSignedCommits: z.boolean().default(true),
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
  /**
   * Most times a failing check may be fixed automatically before a person is
   * needed.
   *
   * Counted apart from `maxRevisions` on purpose. A reviewer disagreeing and a
   * check going red are different kinds of wrong, and one pool for both means a
   * pull request that survived two flaky mornings has no budget left for the
   * first thing a person actually asks for.
   */
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
  /**
   * Whether a mid turn permission request waits for a person.
   *
   * Off by default, and off means exactly today's behaviour: the request falls
   * through to the station's permission mode. On is genuinely different from a
   * plan gate, because this one holds an agent turn open and cannot survive the
   * process, so it is a question with a deadline rather than a durable gate.
   */
  askOnPermission: z.boolean().default(false),
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
