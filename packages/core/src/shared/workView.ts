import type { RunStatus, SubjectKind } from '@/modules/db/schema/schema'

/**
 * One piece of work, however it started.
 *
 * A person describing a feature and a poller finding an issue produce the same
 * thing: a subject, a state, and a thread. The run row already holds all of
 * that, so this is a projection rather than a new store.
 */
export interface WorkItem {
  readonly id: string
  readonly repo: string
  readonly kind: SubjectKind
  readonly number: number
  readonly title: string
  readonly status: RunStatus
  readonly lane: Lane
  /** Which station holds it right now, when one does. */
  readonly station: string | null
  readonly branch: string | null
  readonly prUrl: string | null
  readonly error: string | null
  readonly offeredAt: string | null
  readonly queuedAt: string | null
  readonly startedAt: string
  readonly finishedAt: string | null
}

export const LANES = [
  'needsyou',
  'running',
  'queued',
  'offered',
  'done',
  'failed',
  'dismissed',
] as const
export type Lane = (typeof LANES)[number]

/**
 * What each lane is called, and the one sentence shown when it is empty.
 *
 * Empty copy says what will cause a row to appear rather than that there are
 * none, because "no work" tells a person nothing they did not already know.
 */
export const LANE_COPY: Record<Lane, { label: string; empty: string }> = {
  needsyou: {
    label: 'Waiting on you',
    empty: 'A plan or a permission that needs your answer will appear here.',
  },
  running: {
    label: 'Running',
    empty: 'Work a station is on right now appears here.',
  },
  queued: {
    label: 'Waiting for a slot',
    empty: 'Work you started that is waiting for the machine appears here.',
  },
  offered: {
    label: 'Found on GitHub, not started',
    empty:
      'Issues and pull requests aalai finds appear here until you start them.',
  },
  done: { label: 'Done', empty: 'Finished work appears here.' },
  failed: {
    label: 'Needs another look',
    empty: 'Work that stopped or failed appears here.',
  },
  dismissed: {
    label: 'Dismissed',
    empty: 'Work you turned down appears here.',
  },
}

/**
 * Which lane a run status belongs to.
 *
 * `offered` and `queued` are deliberately separate. Offered means aalai found
 * it and did nothing, which is a decision waiting for a person. Queued means
 * the person already decided and the machine is the one holding it up. Telling
 * a person their laptop is busy when actually nobody has said go would be the
 * worse of the two mistakes.
 *
 * `skipped` is its own lane for the same reason. Dismissing an offer sets it,
 * and a thing a person turned down on purpose is not a thing that went wrong.
 * Filed under failures it would read as an un-actionable error, since nothing
 * on the screen offers to start it again.
 *
 * Every status is named rather than defaulted, so adding one to the enum is a
 * type error here instead of a silent arrival in the failure lane.
 */
export function laneOf(status: RunStatus): Lane {
  switch (status) {
    case 'blocked':
      return 'needsyou'
    case 'running':
      return 'running'
    case 'queued':
      return 'queued'
    case 'offered':
      return 'offered'
    case 'delivered':
      return 'done'
    case 'skipped':
      return 'dismissed'
    case 'failed':
    case 'stopped':
      return 'failed'
  }
}

/**
 * A url safe name for a subject, which has to survive being a route param.
 *
 * A repository has a slash in it and an issue number alone is not unique
 * across repositories, so all four parts are joined. The separator is a tilde
 * because GitHub allows neither owners nor repositories to contain one: owners
 * are alphanumeric and hyphens, repositories add underscore and period. An
 * underscore would have looked like the obvious choice and `my_repo` would
 * have stopped parsing.
 */
const SEPARATOR = '~'

export function workId(subject: {
  repo: string
  kind: SubjectKind
  number: number
}): string {
  const [owner = '', name = ''] = subject.repo.split('/')
  return [owner, name, subject.kind, String(subject.number)].join(SEPARATOR)
}

const WORK_ID =
  /^(?<owner>[A-Za-z0-9-]+)~(?<name>[A-Za-z0-9._-]+)~(?<kind>issue|pr)~(?<number>\d+)$/

export function parseWorkId(
  id: string,
): { repo: string; kind: SubjectKind; number: number } | undefined {
  const g = WORK_ID.exec(id)?.groups
  if (!g?.owner || !g.name || !g.kind || !g.number) {
    return undefined
  }
  return {
    repo: `${g.owner}/${g.name}`,
    kind: g.kind as SubjectKind,
    number: Number(g.number),
  }
}
