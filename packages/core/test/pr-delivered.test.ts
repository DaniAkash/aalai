import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/modules/db/db'
import {
  abandonedPullRequests,
  claimRun,
  completeRun,
  deliveredBranch,
  deliveredPullRequests,
  renewClaim,
  takeOverRun,
} from '@/watch/state'

/** A window that has already elapsed, so any claim counts as abandoned. */
const ELAPSED = -1

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

describe('a claim somebody is still holding', () => {
  test('is not taken over', () => {
    // A watch that runs for days renews its claim. Taking it over anyway starts
    // a second machine on the same branch, which is what the claim is for.
    deliver(7, 31)
    claimRun(handle.sqlite, 'acme/widgets', 31, 30 * 60_000, 'pr')
    expect(
      takeOverRun(handle.sqlite, 'acme/widgets', 31, 30 * 60_000, 'pr'),
    ).toBeNull()
  })

  test('but one that has gone quiet is', () => {
    deliver(7, 31)
    claimRun(handle.sqlite, 'acme/widgets', 31, 30 * 60_000, 'pr')
    // Nothing has renewed it for longer than the window.
    expect(
      takeOverRun(handle.sqlite, 'acme/widgets', 31, ELAPSED, 'pr'),
    ).not.toBeNull()
  })

  test('renewing keeps it out of reach', () => {
    deliver(7, 31)
    const lease =
      claimRun(handle.sqlite, 'acme/widgets', 31, 30 * 60_000, 'pr') ?? ''
    expect(renewClaim(handle.sqlite, 'acme/widgets', 31, lease, 'pr')).toBe(
      true,
    )
    expect(
      takeOverRun(handle.sqlite, 'acme/widgets', 31, 30 * 60_000, 'pr'),
    ).toBeNull()
  })

  test('a worker already replaced cannot renew its own', () => {
    // Fencing. Otherwise the loser of a takeover revives its claim and both
    // workers believe they hold it.
    deliver(7, 31)
    const old =
      claimRun(handle.sqlite, 'acme/widgets', 31, 30 * 60_000, 'pr') ?? ''
    takeOverRun(handle.sqlite, 'acme/widgets', 31, ELAPSED, 'pr')
    expect(renewClaim(handle.sqlite, 'acme/widgets', 31, old, 'pr')).toBe(false)
  })
})

describe('finding a watch whose worker went away', () => {
  test('a quiet claim is offered', () => {
    deliver(7, 31)
    claimRun(handle.sqlite, 'acme/widgets', 31, 30 * 60_000, 'pr')
    expect(abandonedPullRequests(handle.sqlite, ELAPSED)).toHaveLength(1)
  })

  test('a live one is not', () => {
    deliver(7, 31)
    claimRun(handle.sqlite, 'acme/widgets', 31, 30 * 60_000, 'pr')
    expect(abandonedPullRequests(handle.sqlite, 30 * 60_000)).toHaveLength(0)
  })

  test('and a finished one is not', () => {
    deliver(7, 31)
    const lease =
      claimRun(handle.sqlite, 'acme/widgets', 31, 30 * 60_000, 'pr') ?? ''
    completeRun(handle.sqlite, 'acme/widgets', 31, {
      kind: 'pr',
      status: 'delivered',
      lease,
    })
    expect(abandonedPullRequests(handle.sqlite, ELAPSED)).toHaveLength(0)
  })
})

describe('the branch a pull request was delivered on', () => {
  test('is readable once something is already watching it', () => {
    // Resuming is exactly that case, and reading it through the unwatched
    // listing returned nothing, so the resumed watch tried to build a checkout
    // for an empty branch name.
    deliver(7, 31)
    claimRun(handle.sqlite, 'acme/widgets', 31, 30 * 60_000, 'pr')
    expect(deliveredBranch(handle.sqlite, 'acme/widgets', 31)?.branch).toBe(
      'aalai/issue-7',
    )
  })

  test('and names the issue it came from', () => {
    deliver(7, 31)
    expect(
      deliveredBranch(handle.sqlite, 'acme/widgets', 31)?.issueNumber,
    ).toBe(7)
  })

  test('a pull request nobody delivered has none', () => {
    expect(deliveredBranch(handle.sqlite, 'acme/widgets', 99)).toBeUndefined()
  })
})
