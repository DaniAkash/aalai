import { gh, ghJson } from '@/lib/ghExec'
import { headerValue, linkPage, splitResponse } from '@/lib/ghLink'

export interface RepoOwner {
  readonly login: string
  readonly type: 'user' | 'org'
}

export interface OwnedRepo {
  readonly repo: string
  readonly owner: string
  readonly ownerType: 'user' | 'org'
  readonly isPrivate: boolean
  readonly pushedAt: string
  readonly language: string
  readonly stars: number
}

export interface RepoPage {
  readonly repos: OwnedRepo[]
  readonly nextPage: number | null
  readonly lastPage: number | null
}

/** What the REST endpoints return, narrowed to the fields a row shows. */
interface RestRepo {
  readonly full_name: string
  readonly private: boolean
  readonly pushed_at: string | null
  readonly language: string | null
  readonly stargazers_count: number
  readonly owner: { readonly login: string; readonly type: string }
}

export const REPO_PAGE_SIZE = 30

/**
 * Every repository the account can reach, newest push first.
 *
 * `gh repo list` is deliberately not used: it lists only repositories the
 * authenticated user owns, so an account in nine organizations sees none of
 * their repositories and no amount of paging reveals them. The affiliation
 * filter below is what makes organizations visible at all.
 */
export async function accessibleRepos(
  page = 1,
  perPage = REPO_PAGE_SIZE,
): Promise<RepoPage> {
  const query = new URLSearchParams({
    affiliation: 'owner,collaborator,organization_member',
    sort: 'pushed',
    per_page: String(perPage),
    page: String(page),
  })
  const { body, link } = await ghWithHeaders(`/user/repos?${query.toString()}`)
  return page1(JSON.parse(body) as RestRepo[], link)
}

/**
 * Repositories matching a term, across the account and its organizations.
 *
 * Searching has to happen on GitHub rather than over the loaded pages: the
 * account reaches a few hundred repositories, so filtering what has arrived so
 * far answers a question about the first page rather than about the account.
 *
 * Multiple owner qualifiers are OR'd by the search API, which is what lets one
 * query cover the user and every organization at once.
 */
export async function searchRepos(
  term: string,
  page = 1,
  perPage = REPO_PAGE_SIZE,
): Promise<RepoPage> {
  const owners = await repoOwners()
  const scope = owners
    .map((o) => `${o.type === 'org' ? 'org' : 'user'}:${o.login}`)
    .join(' ')
  const query = new URLSearchParams({
    q: `${term} in:name ${scope}`,
    per_page: String(perPage),
    page: String(page),
  })
  const { body, link } = await ghWithHeaders(
    `/search/repositories?${query.toString()}`,
  )
  const parsed = JSON.parse(body) as { items: RestRepo[] }
  return page1(parsed.items, link)
}

/**
 * Every owner that actually has a repository this account can reach.
 *
 * Read from the repository list rather than from `/user/orgs`, because
 * membership is not the only way to reach one: a repository shared through a
 * team, or one the account is a collaborator on, has an owner that appears in
 * no organization list. Scoping a search to membership alone makes those
 * repositories browsable but permanently unfindable.
 *
 * It also stops the selector offering organizations that have nothing in them.
 */
export async function repoOwners(): Promise<RepoOwner[]> {
  const [viewer, repos] = await Promise.all([
    ghJson<{ login: string }>(['api', 'user']),
    allAccessibleOwners(),
  ])
  const others = repos.filter((o) => o.login !== viewer.login)
  return [{ login: viewer.login, type: 'user' }, ...others]
}

async function allAccessibleOwners(): Promise<RepoOwner[]> {
  const query = new URLSearchParams({
    affiliation: 'owner,collaborator,organization_member',
    per_page: '100',
  })
  // One paginated sweep rather than a page at a time: the owner list has to be
  // complete to be useful, and it is asked for once and cached rather than per
  // keystroke.
  const out = await gh([
    'api',
    '--paginate',
    '--jq',
    '.[] | [.owner.login, .owner.type] | @tsv',
    `/user/repos?${query.toString()}`,
  ])
  const seen = new Map<string, RepoOwner>()
  for (const line of out.split('\n')) {
    const [login, type] = line.split('\t')
    if (login === undefined || login === '') {
      continue
    }
    if (!seen.has(login)) {
      seen.set(login, {
        login,
        type: type === 'Organization' ? 'org' : 'user',
      })
    }
  }
  return [...seen.values()]
}

function page1(items: RestRepo[], link: string | undefined): RepoPage {
  return {
    repos: items.map(toOwnedRepo),
    nextPage: linkPage(link, 'next'),
    lastPage: linkPage(link, 'last'),
  }
}

function toOwnedRepo(r: RestRepo): OwnedRepo {
  return {
    repo: r.full_name,
    owner: r.owner.login,
    ownerType: r.owner.type === 'Organization' ? 'org' : 'user',
    isPrivate: r.private,
    pushedAt: r.pushed_at ?? '',
    language: r.language ?? '',
    stars: r.stargazers_count,
  }
}

/**
 * Runs a `gh api` call and keeps the response headers.
 *
 * Only `Link` is wanted, and only because a short page and the last page look
 * identical from the body alone.
 */
async function ghWithHeaders(
  path: string,
): Promise<{ body: string; link: string | undefined }> {
  const { head, body } = splitResponse(
    await gh(['api', '-i', '-X', 'GET', path]),
  )
  return { body, link: headerValue(head, 'link') }
}
