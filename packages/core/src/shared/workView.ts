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
}

/**
 * Which lane a run status belongs to.
 *
 * `offered` and `queued` are deliberately separate. Offered means aalai found
 * it and did nothing, which is a decision waiting for a person. Queued means
 * the person already decided and the machine is the one holding it up. Telling
 * a person their laptop is busy when actually nobody has said go would be the
 * worse of the two mistakes.
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
    default:
      return 'failed'
  }
}

/**
 * A url safe name for a subject.
 *
 * A repository has a slash in it and an issue number alone is not unique
 * across repositories, so the four parts are joined with a separator that
 * appears in none of them.
 */
export function workId(subject: {
  repo: string
  kind: SubjectKind
  number: number
}): string {
  return `${subject.repo.replace('/', '__')}__${subject.kind}__${subject.number}`
}

const WORK_ID =
  /^(?<owner>[^_]+)__(?<name>[^_]+)__(?<kind>issue|pr)__(?<number>\d+)$/

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
