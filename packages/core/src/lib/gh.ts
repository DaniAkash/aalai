import { githubEnv } from '@/lib/credentials'
import { execOrThrow } from '@/lib/proc'

/**
 * An issue as returned by the REST issues endpoint.
 *
 * `gh issue list` is deliberately not used for intake: it exposes no
 * `authorAssociation` field, which is the trust signal the screen depends on.
 * The REST endpoint carries it, at the cost of also returning pull requests as
 * issues, which is what `pull_request` is checked for.
 */
export interface GhIssue {
  readonly number: number
  readonly title: string
  readonly body: string | null
  readonly html_url: string
  readonly state: string
  readonly created_at: string
  readonly updated_at: string
  readonly author_association: string
  readonly user: { readonly login: string } | null
  readonly labels: ReadonlyArray<{ readonly name: string }>
  readonly pull_request?: unknown
}

/**
 * Runs a gh command with the tokens aalai captured at startup.
 *
 * They are removed from the ambient environment so the agent cannot inherit
 * them, so every command that needs one has to ask for it explicitly.
 */
async function gh(args: readonly string[]): Promise<string> {
  return execOrThrow(['gh', ...args], { env: githubEnv() })
}

async function ghJson<T>(args: readonly string[]): Promise<T> {
  return JSON.parse(await gh(args)) as T
}

export async function authenticatedLogin(): Promise<string> {
  const user = await ghJson<{ login: string }>(['api', 'user'])
  return user.login
}

/**
 * Issues updated at or after `since`, oldest update first.
 *
 * Sorted by `updated` rather than `created` so the ordering matches the field
 * `since` filters on. That alignment is what lets a caller advance its cursor to
 * the last item it actually processed: with a mismatched sort, a partially
 * processed batch has no safe cursor value.
 *
 * `--paginate` follows every page, and `--jq '.[]'` flattens them into one
 * object per line, because otherwise each page arrives as its own top-level
 * JSON array and only the first would parse.
 */
export async function listIssuesSince(
  repo: string,
  since: string,
): Promise<GhIssue[]> {
  const query = new URLSearchParams({
    state: 'open',
    since,
    per_page: '100',
    sort: 'updated',
    direction: 'asc',
  })
  const stdout = await gh([
    'api',
    '--paginate',
    '--jq',
    '.[]',
    `repos/${repo}/issues?${query.toString()}`,
  ])
  if (stdout === '') {
    return []
  }
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as GhIssue)
}

export async function getIssue(
  repo: string,
  issueNumber: number,
): Promise<GhIssue> {
  return ghJson<GhIssue>(['api', `repos/${repo}/issues/${issueNumber}`])
}

export async function commentOnIssue(
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await gh([
    'api',
    '--method',
    'POST',
    `repos/${repo}/issues/${issueNumber}/comments`,
    '-f',
    `body=${body}`,
  ])
}

export interface DraftPullRequest {
  readonly repo: string
  readonly head: string
  readonly base: string
  readonly title: string
  readonly body: string
}

/** Opens a draft pull request and returns its URL. Draft is not configurable: it is the human gate. */
export async function createDraftPullRequest(
  input: DraftPullRequest,
): Promise<string> {
  const stdout = await gh([
    'pr',
    'create',
    '--repo',
    input.repo,
    '--head',
    input.head,
    '--base',
    input.base,
    '--title',
    input.title,
    '--body',
    input.body,
    '--draft',
  ])
  const url = stdout.split('\n').find((line) => line.startsWith('https://'))
  if (url === undefined) {
    throw new Error(`gh pr create produced no pull request URL: ${stdout}`)
  }
  return url
}

export interface OwnedRepo {
  readonly repo: string
  readonly isPrivate: boolean
}

/**
 * Repositories the signed in account can push to.
 *
 * Read through the CLI that is already authenticated, so the picker offers
 * real choices rather than a text field the user has to spell correctly.
 */
export async function ownedRepos(limit = 200): Promise<OwnedRepo[]> {
  const out = await execOrThrow(
    [
      'gh',
      'repo',
      'list',
      '--limit',
      String(limit),
      '--json',
      'nameWithOwner,isPrivate',
    ],
    { env: githubEnv() },
  )
  const parsed = JSON.parse(out) as {
    nameWithOwner: string
    isPrivate: boolean
  }[]
  return parsed.map((r) => ({ repo: r.nameWithOwner, isPrivate: r.isPrivate }))
}
