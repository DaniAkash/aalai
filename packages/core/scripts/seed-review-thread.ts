import {
  recordReviewAnswer,
  recordReviewComments,
} from '@/modules/work/reviews'

/**
 * A review conversation on the demo subject, for looking at the thread.
 *
 * The shapes that matter are all here: an answered comment with a commit, an
 * answered one without, and one nobody has answered yet.
 */

const subject = {
  repo: 'DaniAkash/aalai-demo',
  kind: 'issue' as const,
  number: 61,
}
const say = (line: string) => process.stdout.write(`${line}\n`)

await recordReviewComments(subject, [
  {
    id: '9001',
    author: 'Copilot',
    body: 'The rounding here truncates rather than rounds, so 1536 renders as "1.5 KB" by accident rather than by design. Consider Math.round on the scaled value.',
    path: 'src/bytes.ts',
    line: 24,
    at: '2026-10-09T11:00:00Z',
  },
  {
    id: '9002',
    author: 'Copilot',
    body: 'formatBytes(0) returns "0 B" here but the unit table starts at 1, so the loop is skipped entirely. Worth a test.',
    path: 'src/bytes.ts',
    line: 31,
    at: '2026-10-09T11:01:00Z',
  },
  {
    id: '9003',
    author: 'Copilot',
    body: 'This comment has not been answered yet, and should read as waiting rather than as settled.',
    path: 'src/bytes.ts',
    line: 44,
    at: '2026-10-09T11:02:00Z',
  },
])

await recordReviewAnswer(subject, {
  threadId: '9001',
  answer:
    'Correct. Rounded to one decimal rather than truncating, and added the boundary case to the unit tests.',
  commitSha: '4f2c9a18b3d0e7715c6a',
  station: 'reviewer',
  at: '2026-10-09T11:10:00Z',
})
await recordReviewAnswer(subject, {
  threadId: '9002',
  answer:
    'This one should stand as it is. Zero is deliberately outside the unit loop so the smallest value reads as bytes rather than as a fraction of a kilobyte. Added a test that pins it.',
  commitSha: null,
  station: 'reviewer',
  at: '2026-10-09T11:12:00Z',
})

say('seeded 3 review comments on DaniAkash/aalai-demo#61, 2 answered')
