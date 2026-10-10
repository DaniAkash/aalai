import { gh, ghJson } from '@/lib/ghExec'

/**
 * Replying inside a review thread, and closing it afterwards.
 *
 * Two different interfaces, because GitHub keeps them apart. Replying is REST
 * and keyed on the comment being answered. Resolving is GraphQL only and keyed
 * on the thread's node id, which is not the comment id and cannot be derived
 * from it, so the mapping below is a lookup rather than a calculation.
 */

export interface PostedReply {
  readonly id: number
  readonly html_url: string
  readonly body: string
  readonly author: string
}

/**
 * Replies under the comment being answered, inside its thread.
 *
 * The replies endpoint rather than a new review comment at the same path and
 * line. That alternative returns a perfectly good comment and starts a second
 * thread beside the original, which reads to the reviewer as having been
 * ignored by somebody who happened to write about the same line.
 */
export async function replyInThread(
  repo: string,
  prNumber: number,
  commentId: string,
  body: string,
): Promise<PostedReply> {
  const raw = await ghJson<{
    id: number
    html_url: string
    body: string
    user: { login: string } | null
  }>([
    'api',
    '--method',
    'POST',
    `repos/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
    '-f',
    `body=${body}`,
  ])
  return {
    id: raw.id,
    html_url: raw.html_url,
    body: raw.body,
    author: raw.user?.login ?? '',
  }
}

/**
 * Replies to a review that was left at the top level rather than on a line.
 *
 * A summary has no thread to reply in, so this is a pull request comment. The
 * reviewer is named in the body because that is the only thing connecting the
 * reply to what it answers once it is sitting in the conversation on its own.
 */
export async function replyToSummary(
  repo: string,
  prNumber: number,
  body: string,
): Promise<PostedReply> {
  const raw = await ghJson<{
    id: number
    html_url: string
    body: string
    user: { login: string } | null
  }>([
    'api',
    '--method',
    'POST',
    `repos/${repo}/issues/${prNumber}/comments`,
    '-f',
    `body=${body}`,
  ])
  return {
    id: raw.id,
    html_url: raw.html_url,
    body: raw.body,
    author: raw.user?.login ?? '',
  }
}

export interface ReviewThread {
  readonly id: string
  readonly isResolved: boolean
  /** The REST ids of the comments in it, which is what an answer refers to. */
  readonly commentIds: readonly string[]
}

interface ThreadsPage {
  readonly data: {
    readonly repository: {
      readonly pullRequest: {
        readonly reviewThreads: {
          readonly nodes: readonly {
            readonly id: string
            readonly isResolved: boolean
            readonly comments: {
              readonly nodes: readonly { readonly databaseId: number }[]
            }
          }[]
          readonly pageInfo: {
            readonly hasNextPage: boolean
            readonly endCursor: string | null
          }
        }
      }
    }
  }
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:50,after:$after){
        nodes{ id isResolved comments(first:100){ nodes{ databaseId } } }
        pageInfo{ hasNextPage endCursor }
      }
    }
  }
}`

/**
 * Every review thread on a pull request, with the comment ids inside each.
 *
 * Paginated on the threads and reading up to a hundred comments in each,
 * because the comment an answer names may be a reply rather than the opener of
 * its thread. Matching only on the first comment would leave an answer to a
 * follow up unable to find the thread it belongs to.
 */
export async function listReviewThreads(
  repo: string,
  prNumber: number,
): Promise<ReviewThread[]> {
  const [owner = '', name = ''] = repo.split('/')
  const out: ReviewThread[] = []
  let after: string | null = null

  do {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${THREADS_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `number=${prNumber}`,
    ]
    if (after !== null) {
      args.push('-F', `after=${after}`)
    }
    const page: ThreadsPage = JSON.parse(await gh(args)) as ThreadsPage
    const threads = page.data.repository.pullRequest.reviewThreads
    for (const node of threads.nodes) {
      out.push({
        id: node.id,
        isResolved: node.isResolved,
        commentIds: node.comments.nodes.map((c) => String(c.databaseId)),
      })
    }
    after = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null
  } while (after !== null)

  return out
}

/** The thread one comment sits in, by the REST id an answer names. */
export function threadHolding(
  threads: readonly ReviewThread[],
  commentId: string,
): ReviewThread | undefined {
  return threads.find((thread) => thread.commentIds.includes(commentId))
}

/**
 * Closes a thread. Already closed is success, not an error.
 *
 * Resolving twice is what a retry after a partial failure does, and treating
 * it as a failure would make a batch look worse on its second attempt than its
 * first.
 */
export async function resolveReviewThread(threadId: string): Promise<void> {
  await gh([
    'api',
    'graphql',
    '-f',
    'query=mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread { isResolved } } }',
    '-F',
    `id=${threadId}`,
  ])
}
