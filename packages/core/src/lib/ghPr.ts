import { gh } from '@/lib/ghExec'

/**
 * What GitHub says about a pull request after it exists.
 *
 * Separate from `gh.ts` because it answers a different question. That module is
 * about finding work and saying something back; this one is about a thing that
 * is already open and keeps changing without being asked.
 */

export interface CheckRun {
  readonly name: string
  readonly status: string
  /** Null until it has finished, which is why it is asked for separately. */
  readonly conclusion: string | null
  readonly id: number
  readonly html_url: string
}

/**
 * The checks on one commit.
 *
 * Keyed on the sha rather than on the pull request, because a result belongs to
 * a commit and a pull request's head moves. Asking by pull request would let a
 * failure from a commit that has since been replaced look current.
 */
export async function listCheckRuns(
  repo: string,
  sha: string,
): Promise<CheckRun[]> {
  const stdout = await gh([
    'api',
    '--paginate',
    `repos/${repo}/commits/${sha}/check-runs`,
    '--jq',
    '.check_runs[] | {name, status, conclusion, id, html_url}',
  ])
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CheckRun)
}

export interface PullRequestState {
  readonly number: number
  readonly state: string
  readonly isDraft: boolean
  readonly headSha: string
  readonly headRef: string
  readonly baseRef: string
  readonly mergeable: string | null
  readonly url: string
}

/** Where a pull request currently stands, including the head its checks belong to. */
export async function pullRequestState(
  repo: string,
  number: number,
): Promise<PullRequestState> {
  const stdout = await gh([
    'pr',
    'view',
    String(number),
    '--repo',
    repo,
    '--json',
    'number,state,isDraft,headRefOid,headRefName,baseRefName,mergeable,url',
  ])
  const raw = JSON.parse(stdout) as Record<string, unknown>
  return {
    number: raw.number as number,
    state: raw.state as string,
    isDraft: raw.isDraft as boolean,
    headSha: raw.headRefOid as string,
    headRef: raw.headRefName as string,
    baseRef: raw.baseRefName as string,
    mergeable: (raw.mergeable as string | null) ?? null,
    url: raw.url as string,
  }
}

export interface ReviewComment {
  readonly id: number
  readonly body: string
  readonly author: string
  readonly path: string | null
  readonly line: number | null
  readonly created_at: string
  readonly in_reply_to_id: number | null
}

/**
 * Review comments on a pull request, oldest first.
 *
 * The threading id is carried because replying in the thread is the point: a
 * comment answered by a new top level comment reads as ignoring it.
 */
export async function listReviewComments(
  repo: string,
  number: number,
): Promise<ReviewComment[]> {
  const stdout = await gh([
    'api',
    '--paginate',
    `repos/${repo}/pulls/${number}/comments`,
    '--jq',
    '.[] | {id, body, author: .user.login, path, line, created_at, in_reply_to_id}',
  ])
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ReviewComment)
}

/** The head commit of a branch, and who wrote it. */
export async function branchHead(
  repo: string,
  branch: string,
): Promise<{ sha: string; author: string }> {
  const stdout = await gh([
    'api',
    `repos/${repo}/commits/${branch}`,
    '--jq',
    '{sha, author: (.author.login // .commit.author.name)}',
  ])
  return JSON.parse(stdout) as { sha: string; author: string }
}

/**
 * The most recent workflow run for a branch, which is where a log lives.
 *
 * Named for the workflow rather than just the run: `latestRunId` already means
 * the newest run the factory itself started, and the two are different things
 * that would otherwise be one import away from each other.
 */
export async function latestWorkflowRunId(
  repo: string,
  branch: string,
): Promise<number | undefined> {
  const stdout = await gh([
    'run',
    'list',
    '--repo',
    repo,
    '--branch',
    branch,
    '--limit',
    '1',
    '--json',
    'databaseId',
    '--jq',
    '.[0].databaseId // empty',
  ])
  const id = Number(stdout.trim())
  return Number.isFinite(id) && id > 0 ? id : undefined
}

/**
 * The part of a log that says why something failed.
 *
 * Not the tail. A test runner prints its failure and the job then carries on
 * tidying up, so the last lines of a failed log are cleanup and the assertion
 * is somewhere in the middle: taking the end of a real one gave forty lines of
 * housekeeping and no mention of the test that failed.
 *
 * Windowed per job rather than once over the whole thing. `--log-failed`
 * concatenates every failed job, and anchoring on the last failure in that
 * meant a run with two red checks handed over evidence for one of them: a real
 * pull request failing both its tests and an unrelated infrastructure job
 * produced a window mentioning the test and nothing at all about the other,
 * while the question being asked named both. A verdict on evidence that
 * silently omits half the failure is worse than no verdict.
 */
export function windowAroundFailure(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) {
    return text
  }
  const jobs = groupByJob(lines)
  const share = Math.max(20, Math.floor(maxLines / jobs.length))
  return jobs.map((job) => windowOne(job, share)).join('\n')
}

/**
 * `gh` prefixes every line with its job name, which is what separates them.
 *
 * A line with no prefix belongs to one unnamed job rather than to a job of its
 * own, or a log that is not in this shape becomes one job per line and the
 * windowing stops windowing anything.
 */
function groupByJob(lines: readonly string[]): string[][] {
  const jobs = new Map<string, string[]>()
  for (const line of lines) {
    const name = line.includes('\t') ? (line.split('\t')[0] ?? '') : ''
    const bucket = jobs.get(name)
    if (bucket === undefined) {
      jobs.set(name, [line])
    } else {
      bucket.push(line)
    }
  }
  return [...jobs.values()]
}

function windowOne(lines: readonly string[], maxLines: number): string {
  if (lines.length <= maxLines) {
    return lines.join('\n')
  }
  const marker = /error:|expect\(|Expected|Received|\(fail\)|##\[error\]|FAIL/i
  let anchor = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (marker.test(lines[i] ?? '')) {
      anchor = i
      break
    }
  }
  if (anchor === -1) {
    return lines.slice(0, maxLines).join('\n')
  }
  const after = Math.floor(maxLines / 4)
  const start = Math.max(0, anchor - (maxLines - after))
  return lines.slice(start, Math.min(lines.length, anchor + after)).join('\n')
}

/**
 * The log of whatever failed in a run, trimmed to what explains it.
 *
 * Capped because an unbounded log becomes an unbounded prompt, and this one is
 * written by somebody else's test runner.
 */
export async function failedLog(
  repo: string,
  runId: number,
  maxLines = 120,
): Promise<string> {
  const stdout = await gh([
    'run',
    'view',
    String(runId),
    '--repo',
    repo,
    '--log-failed',
  ])
  return windowAroundFailure(stdout, maxLines)
}
