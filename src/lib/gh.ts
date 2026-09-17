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

async function ghJson<T>(args: readonly string[]): Promise<T> {
  const stdout = await execOrThrow(['gh', ...args])
  return JSON.parse(stdout) as T
}

export async function authenticatedLogin(): Promise<string> {
  const user = await ghJson<{ login: string }>(['api', 'user'])
  return user.login
}

/**
 * Issues updated at or after `since`, newest activity first.
 *
 * GitHub's `since` filter is inclusive and matches on `updated_at`, so the
 * caller is responsible for discarding items it has already handled. The claim
 * table is what makes that safe; the cursor alone only bounds the page size.
 */
export async function listIssuesSince(repo: string, since: string): Promise<GhIssue[]> {
  const query = new URLSearchParams({
    state: 'open',
    since,
    per_page: '50',
    sort: 'created',
    direction: 'desc',
  })
  return ghJson<GhIssue[]>(['api', `repos/${repo}/issues?${query.toString()}`])
}

export async function getIssue(repo: string, issueNumber: number): Promise<GhIssue> {
  return ghJson<GhIssue>(['api', `repos/${repo}/issues/${issueNumber}`])
}

export async function commentOnIssue(
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await execOrThrow([
    'gh',
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
export async function createDraftPullRequest(input: DraftPullRequest): Promise<string> {
  const stdout = await execOrThrow([
    'gh',
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
