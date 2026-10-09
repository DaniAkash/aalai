import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { listReviewComments } from '@/lib/ghPr'
import { grantToolAccess, revokeToolAccess } from '@/modules/tools/context'
import { recordReviewComments } from '@/modules/work/reviews'
import { readWorkThread } from '@/modules/work/thread'
import { openState } from '@/watch/state'

/**
 * The review loop against a real pull request, end to end.
 *
 * Reads the review GitHub actually holds, records it the way the watcher
 * does, answers one comment through the real tool over the real protocol, and
 * reads the thread back. Everything between a reviewer leaving a comment and a
 * person reading the answer is the shipping path. Only the agent's judgement
 * about what to say is stood in for, which is the part not under test.
 *
 * Arguments: `owner/name#pr` and the issue number its thread belongs to.
 */

const [target = 'DaniAkash/aalai-demo#69', issueArg = '68'] = Bun.argv.slice(2)
const [repo = '', prText = '0'] = target.split('#')
const prNumber = Number(prText)
const subject = { repo, kind: 'issue' as const, number: Number(issueArg) }
const say = (line: string) => process.stdout.write(`${line}\n`)

say(`reading the review on ${repo}#${prNumber}`)
const comments = await listReviewComments(repo, prNumber)
say(`  github holds ${comments.length} review comment(s)`)
if (comments.length === 0) {
  say('  nothing to do until a review has been left on it')
  process.exit(1)
}
for (const comment of comments) {
  say(`  ${comment.author}: ${comment.body.slice(0, 72).replace(/\n/g, ' ')}`)
}

// Exactly what the watcher does on every poll, including the second time.
const added = await recordReviewComments(
  subject,
  comments.map((comment) => ({
    id: String(comment.id),
    author: comment.author,
    body: comment.body,
    path: comment.path ?? null,
    line: comment.line ?? null,
    at: comment.created_at,
  })),
)
say(`  recorded ${added.length} new`)
const again = await recordReviewComments(
  subject,
  comments.map((comment) => ({
    id: String(comment.id),
    author: comment.author,
    body: comment.body,
    path: comment.path ?? null,
    line: comment.line ?? null,
    at: comment.created_at,
  })),
)
say(`  recorded ${again.length} on a second pass, which should be 0`)

const first = comments[0]
if (first === undefined) {
  process.exit(1)
}

say('answering one of them through the tool a station uses')
const runId = `${repo}#${subject.number}@${Date.now()}`
const { token } = grantToolAccess({
  runId,
  title: 'formatDuration drops the leading zero',
  subject,
  run: { subject, runId },
  station: 'reviewer',
  worktreePath: process.cwd(),
})
const { app } = await import('@/server/app')
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch })
const client = new Client({ name: 'review-loop-e2e', version: '1' })
await client.connect(
  new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${server.port}/api/mcp/${token}`),
  ),
)
const result = await client.callTool({
  name: 'answer_review_comment',
  arguments: {
    thread_id: String(first.id),
    answer:
      'Addressed. The seconds are padded to two digits, and the tests now cover the boundary either side of ten as well as a whole minute.',
    commit_sha: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  },
})
say(`  tool refused: ${result.isError === true}`)
await client.close()
server.stop(true)
revokeToolAccess(token)

say('reading the thread back')
const db = openState()
try {
  const view = await readWorkThread(db, subject)
  const reviewed = view.turns.filter((turn) => turn.kind === 'reviewed')
  say(`  ${reviewed.length} review turn(s) in the thread`)
  for (const turn of reviewed) {
    if (turn.kind !== 'reviewed') {
      continue
    }
    const where = turn.path === null ? '' : ` ${turn.path}:${turn.line}`
    const answered =
      turn.answer === null
        ? 'not answered yet'
        : `answered${turn.commitSha === null ? '' : ` at ${turn.commitSha.slice(0, 7)}`}`
    say(`  ${turn.author}${where} -> ${answered}`)
  }
} finally {
  db.close()
}
