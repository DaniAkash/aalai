import { gh, ghJson } from '@/lib/ghExec'

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

/** A comment aalai posted, named well enough to find again. */
export interface PostedComment {
  readonly id: number
  readonly html_url: string
}

/**
 * Posts a comment and says which one it posted.
 *
 * The identifier is the point. Delivery has to survive a crash between the post
 * landing and aalai recording that it landed, and the only way to tell that
 * apart from a post that never happened is to be able to look for it.
 */
export async function commentOnIssue(
  repo: string,
  issueNumber: number,
  body: string,
): Promise<PostedComment> {
  return await ghJson<PostedComment>([
    'api',
    '--method',
    'POST',
    `repos/${repo}/issues/${issueNumber}/comments`,
    '-f',
    `body=${body}`,
  ])
}

export interface IssueComment {
  readonly id: number
  readonly html_url: string
  readonly body: string
  readonly author: string
  readonly created_at: string
}

/**
 * Comments on an issue, oldest first.
 *
 * Carries the author and the time because two different questions are asked of
 * this: whether aalai already posted something, and whether the reporter has
 * answered. The second needs to know who spoke and when.
 */
export async function listIssueCommentBodies(
  repo: string,
  issueNumber: number,
): Promise<IssueComment[]> {
  const lines = await gh([
    'api',
    '--paginate',
    `repos/${repo}/issues/${issueNumber}/comments`,
    '--jq',
    '.[] | {id, html_url, body, author: .user.login, created_at}',
  ])
  return lines
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as IssueComment)
}

/**
 * Closes an issue, with a reason GitHub understands.
 *
 * `completed` and `not_planned` are not cosmetic: GitHub renders them
 * differently and a duplicate closed as `completed` reads as though the work was
 * done. Triage closes almost everything as `not_planned`.
 */
export async function closeIssue(
  repo: string,
  issueNumber: number,
  reason: 'completed' | 'not_planned' = 'not_planned',
): Promise<void> {
  await gh([
    'api',
    '--method',
    'PATCH',
    `repos/${repo}/issues/${issueNumber}`,
    '-f',
    'state=closed',
    '-f',
    `state_reason=${reason}`,
  ])
}

/**
 * Opens an issue from a brief, and returns it as the watcher would have seen it.
 *
 * Work described in the app becomes a real issue rather than a local record.
 * Everything downstream hangs off a subject: the thread, the gates, the
 * artifacts, the pull request that closes it. A local-only piece of work would
 * be a second kind that none of those could reference and nobody else could
 * see, which is the opposite of what this is for.
 */
export async function createIssue(
  repo: string,
  title: string,
  body: string,
): Promise<GhIssue> {
  return await ghJson<GhIssue>([
    'api',
    '--method',
    'POST',
    `repos/${repo}/issues`,
    '-f',
    `title=${title}`,
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
