import type { CheckRun, ReviewComment } from '@/lib/ghPr'

/**
 * What changed about a pull request since the last time anybody looked.
 *
 * Pure, and separate from the asking, because this is the part with the
 * judgement in it: what counts as new. Everything here is a comparison against
 * what was seen before rather than an event, because nothing pushes to a
 * desktop application and a poll that misses a tick must not miss a fact.
 */

export interface Seen {
  /**
   * Whether anything has been looked at yet.
   *
   * The difference between "the base is not where it was" and "nobody has ever
   * recorded where the base is" is the whole of it. Inferring it from an empty
   * sha was how the first version reported a brand new pull request's own base
   * as having moved, and then stopped the run before it had looked at a single
   * check.
   */
  readonly looked: boolean
  /** The commit the last look was about. Results belong to a commit, not to a pull request. */
  readonly headSha: string
  /** The newest review comment already handled. */
  readonly lastCommentId: number
  /** Where the base was, so moving it is visible. */
  readonly baseSha: string
  /** Checks already reported failing on `headSha`, so one failure is reported once. */
  readonly failedChecks: readonly string[]
  /**
   * The commit this run last pushed, or empty before it has pushed any.
   *
   * The dependable way to notice somebody else working on the branch. Comparing
   * the head commit's author only works when the factory and the maintainer are
   * different accounts, and on a personal repository they are the same one: a
   * real pull request here reported its head as authored by exactly the login
   * the factory pushes as, so a hand written commit would have been invisible.
   * A commit nobody here pushed is somebody else's whoever it says wrote it.
   */
  readonly pushedSha: string
}

export interface Look {
  readonly headSha: string
  readonly headAuthor: string
  readonly baseSha: string
  readonly checks: readonly CheckRun[]
  readonly comments: readonly ReviewComment[]
  /** Who we are, so our own comments are not read as somebody asking for something. */
  readonly me: string
}

export type Signal =
  | { readonly kind: 'checks_failed'; readonly names: readonly string[] }
  | { readonly kind: 'checks_passed' }
  | { readonly kind: 'comments'; readonly comments: readonly ReviewComment[] }
  | { readonly kind: 'base_moved'; readonly baseSha: string }
  | { readonly kind: 'branch_touched'; readonly author: string }

/** Whether every check has finished, so a red one is a verdict rather than a moment. */
export function checksSettled(checks: readonly CheckRun[]): boolean {
  return checks.length > 0 && checks.every((c) => c.status === 'completed')
}

/**
 * The conclusions that are not a problem.
 *
 * Everything else is, including `timed_out`, `cancelled`, `startup_failure`,
 * `stale` and `action_required`. Listing the good ones rather than the bad ones
 * is deliberate: the first version tested for `failure` alone, so a timed out
 * check counted as neither failing nor pending and a pull request with a red
 * tick on GitHub could be reported as green and the watch stopped as settled.
 * A conclusion nobody here has heard of should read as a problem, not as fine.
 */
const FINE = new Set(['success', 'neutral', 'skipped'])

function isFailing(check: CheckRun): boolean {
  return (
    check.status === 'completed' &&
    check.conclusion !== null &&
    !FINE.has(check.conclusion)
  )
}

/**
 * The signals in one look, given what was already known.
 *
 * Order matters to the caller: a branch somebody else touched is reported
 * first, because every other signal leads to a push and that one forbids it.
 */
export function signalsFrom(seen: Seen, look: Look): Signal[] {
  // Two of these need something to compare against and two do not, which is
  // what a first look has to distinguish. Nobody has moved a base nobody had
  // recorded, and the commit already on the branch is the one delivery pushed,
  // so neither is news. A check that is already red and a comment nobody has
  // answered are news the moment they are seen, because they are true now
  // rather than being a change from something.
  return [
    ...(seen.looked ? sinceLastLook(seen, look) : []),
    ...trueRightNow(seen, look),
  ]
}

/** The two that only mean anything against a previous observation. */
function sinceLastLook(seen: Seen, look: Look): Signal[] {
  const signals: Signal[] = []
  if (headIsNotOurs(seen, look)) {
    signals.push({ kind: 'branch_touched', author: look.headAuthor })
  }
  if (look.baseSha !== '' && look.baseSha !== seen.baseSha) {
    signals.push({ kind: 'base_moved', baseSha: look.baseSha })
  }
  return signals
}

/**
 * Whether somebody else put the current commit there.
 *
 * When the commit this run pushed is known, that is the answer and the author is
 * not consulted. Falling through to the author after a matching sha was how a
 * commit we had just pushed ourselves got reported as somebody else's, because
 * the author field is the unreliable half: on a personal repository it reads as
 * the same account whoever pushed.
 */
function headIsNotOurs(seen: Seen, look: Look): boolean {
  return seen.pushedSha !== ''
    ? look.headSha !== seen.pushedSha
    : look.headAuthor !== '' && look.headAuthor !== look.me
}

/** The two that are facts about now rather than changes from before. */
function trueRightNow(seen: Seen, look: Look): Signal[] {
  const signals: Signal[] = []

  // Only once the run has finished. A check in flight is not a passing one, and
  // reporting red the moment the first job fails would revise against a picture
  // that is still being painted.
  if (checksSettled(look.checks)) {
    const failed = look.checks.filter(isFailing).map((c) => c.name)
    // A failure already reported on this same commit is the same failure. A new
    // commit resets that, because the results then belong to a different thing.
    const fresh =
      look.headSha === seen.headSha
        ? failed.filter((name) => !seen.failedChecks.includes(name))
        : failed
    if (fresh.length > 0) {
      signals.push({ kind: 'checks_failed', names: fresh })
    } else if (failed.length === 0 && look.headSha !== seen.headSha) {
      signals.push({ kind: 'checks_passed' })
    }
  }

  // Ours are not somebody asking for something, and neither is anything already
  // handled. Replies inside a thread we started are still theirs.
  const said = look.comments.filter(
    (c) => c.author !== look.me && c.id > seen.lastCommentId,
  )
  if (said.length > 0) {
    signals.push({ kind: 'comments', comments: said })
  }

  return signals
}

/** What to remember after acting on a look, so the next one compares against it. */
export function seenAfter(seen: Seen, look: Look, signals: Signal[]): Seen {
  const failed = look.checks.filter(isFailing).map((c) => c.name)
  const comments = signals.find((s) => s.kind === 'comments')
  return {
    looked: true,
    // On the first look the commit already on the branch is the one delivery
    // pushed, so it is recorded as ours. Without that, the next look would
    // report the run's own delivered commit as somebody else's work.
    pushedSha: seen.looked ? seen.pushedSha : look.headSha,
    headSha: look.headSha,
    baseSha: look.baseSha === '' ? seen.baseSha : look.baseSha,
    // What is failing now, not everything that ever failed on this commit.
    // Unioning them meant a check that failed, was rerun green, then failed
    // again on the same commit was filtered out forever and never looked at
    // again, which is exactly the rerun somebody does to see if it was flaky.
    failedChecks: failed,
    lastCommentId:
      comments === undefined
        ? seen.lastCommentId
        : Math.max(seen.lastCommentId, ...comments.comments.map((c) => c.id)),
  }
}
