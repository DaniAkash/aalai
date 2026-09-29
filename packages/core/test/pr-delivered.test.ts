import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/modules/db/db'
import { claimRun, completeRun, deliveredPullRequests } from '@/watch/state'

/**
 * Finding the pull requests nothing is watching.
 *
 * The one that matters is not starting a second watch on the same pull
 * request: two watches on one branch is two revisions on one branch, which is
 * the thing the whole window exists to avoid.
 */

let dir: string
let handle: ReturnType<typeof openDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-pr-'))
  process.env.AALAI_STATE_DIR = dir
  handle = openDb(join(dir, 'aalai.sqlite'))
})

afterEach(() => {
  handle.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

function deliver(issue: number, prNumber: number) {
  const lease = claimRun(handle.sqlite, 'acme/widgets', issue) ?? ''
  completeRun(handle.sqlite, 'acme/widgets', issue, {
    status: 'delivered',
    prUrl: `https://github.com/acme/widgets/pull/${prNumber}`,
    branch: `aalai/issue-${issue}`,
    lease,
  })
}

describe('what is waiting to be watched', () => {
  test('a delivered pull request is offered', () => {
    deliver(7, 31)
    const open = deliveredPullRequests(handle.sqlite)
    expect(open).toHaveLength(1)
    expect(open[0]?.prNumber).toBe(31)
    expect(open[0]?.issueNumber).toBe(7)
  })

  test('one already being watched is not offered again', () => {
    // Two watches on one branch is two revisions on one branch.
    deliver(7, 31)
    claimRun(handle.sqlite, 'acme/widgets', 31, 30 * 60_000, 'pr')
    expect(deliveredPullRequests(handle.sqlite)).toHaveLength(0)
  })

  test('a run that delivered nothing is not offered', () => {
    const lease = claimRun(handle.sqlite, 'acme/widgets', 9) ?? ''
    completeRun(handle.sqlite, 'acme/widgets', 9, {
      status: 'skipped',
      lease,
    })
    expect(deliveredPullRequests(handle.sqlite)).toHaveLength(0)
  })

  test('a delivered run with no pull request url is skipped, not guessed at', () => {
    const lease = claimRun(handle.sqlite, 'acme/widgets', 11) ?? ''
    completeRun(handle.sqlite, 'acme/widgets', 11, {
      status: 'delivered',
      branch: 'aalai/issue-11',
      lease,
    })
    expect(deliveredPullRequests(handle.sqlite)).toHaveLength(0)
  })

  test('a finished watch does not come back', () => {
    // The pr row still exists once the watch ends, which is what keeps it from
    // being picked up forever.
    deliver(7, 31)
    const lease =
      claimRun(handle.sqlite, 'acme/widgets', 31, 30 * 60_000, 'pr') ?? ''
    completeRun(handle.sqlite, 'acme/widgets', 31, {
      kind: 'pr',
      status: 'delivered',
      lease,
    })
    expect(deliveredPullRequests(handle.sqlite)).toHaveLength(0)
  })

  test('two issues delivering two pull requests offer both', () => {
    deliver(7, 31)
    deliver(8, 32)
    expect(deliveredPullRequests(handle.sqlite).map((p) => p.prNumber)).toEqual(
      [31, 32],
    )
  })
})
