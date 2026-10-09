import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { loadConfig } from '@/config'
import { activeRuns, replay } from '@/events/bus'
import type { RunEvent, StationId } from '@/events/events.types'
import {
  listQueue,
  type QueueEntry,
  readRun,
  runningCount,
} from '@/modules/runs/queue'
import { readArtifact } from '@/modules/work/artifacts'
import { readChanges, readFilePatch } from '@/modules/work/changes'
import { parseArtifactId, repoSegment } from '@/modules/work/paths'
import { readWorkThread } from '@/modules/work/thread'
import {
  activityKeyOfRun,
  advanceActivity,
  NO_ACTIVITY,
  type SubjectActivity,
  stationName,
} from '@/shared/stepActivity'
import {
  LANES,
  type Lane,
  laneOf,
  type ParsedWorkId,
  parseWorkId,
  type WorkItem,
  workId,
} from '@/shared/workView'
import { openState } from '@/watch/state'

/**
 * The work list: every piece of work, grouped the way a person reads it.
 *
 * One request rather than three. The screen needs the rows, the counts and the
 * ceiling together, and fetching them separately means three loading states
 * that settle at different moments and a list that reflows twice.
 */
export const workRoute = new Hono()
  .get('/work', async (c) => {
    const repo = c.req.query('repo')
    const config = await loadConfig()
    const db = openState()
    try {
      const stations = runningStations()
      const activity = runningActivity()
      const items = listQueue(db)
        .filter((entry) => repo === undefined || entry.repo === repo)
        .map((entry): WorkItem => {
          return {
            id: workId(entry),
            repo: entry.repo,
            kind: entry.kind,
            number: entry.number,
            // Something discovered but never opened has no title yet. The subject
            // is the only honest thing to show until GitHub's is read.
            title: entry.title ?? `${entry.kind} #${entry.number}`,
            status: entry.status,
            lane: laneOf(entry.status),
            // Only a running row has a station. The event buffer retains
            // finished runs, so without this a delivered row would show the
            // last stage it passed through as though it were happening now.
            station:
              entry.status === 'running'
                ? (stations.get(`${entry.repo}#${entry.number}`) ?? null)
                : null,
            activity:
              entry.status === 'running'
                ? (activity.get(`${entry.repo}#${entry.number}`) ?? null)
                : null,
            branch: entry.branch,
            prUrl: entry.prUrl,
            error: entry.error,
            offeredAt: entry.offeredAt,
            queuedAt: entry.queuedAt,
            startedAt: entry.startedAt,
            finishedAt: entry.finishedAt,
          }
        })

      return c.json({
        lanes: LANES.map((lane) => ({
          key: lane,
          items: items.filter((item) => item.lane === lane),
        })),
        counts: countByLane(items),
        total: items.length,
        running: runningCount(db),
        capacity: config.maxParallelRuns,
        paused: config.queuePaused,
      })
    } finally {
      db.close()
    }
  })
  .get('/work/:id', async (c) => {
    const found = findWork(c.req.param('id'))
    if (typeof found === 'string') {
      return found === 'bad-id'
        ? c.json({ error: 'not a work id' }, 400)
        : c.json({ error: 'no such work' }, 404)
    }
    const { entry, subject } = found
    const db = openState()
    try {
      const thread = await readWorkThread(db, subject)
      return c.json({
        item: {
          id: workId(entry),
          repo: entry.repo,
          kind: entry.kind,
          number: entry.number,
          title: entry.title ?? `${entry.kind} #${entry.number}`,
          status: entry.status,
          lane: laneOf(entry.status),
          station:
            entry.status === 'running'
              ? (runningStations().get(`${entry.repo}#${entry.number}`) ?? null)
              : null,
          // Seeds the live store, so a thread opened between two reports shows
          // the running step rather than nothing until the next one arrives.
          activity:
            entry.status === 'running'
              ? (runningActivity().get(`${entry.repo}#${entry.number}`) ?? null)
              : null,
          branch: entry.branch,
          prUrl: entry.prUrl,
          error: entry.error,
          offeredAt: entry.offeredAt,
          queuedAt: entry.queuedAt,
          startedAt: entry.startedAt,
          finishedAt: entry.finishedAt,
        } satisfies WorkItem,
        ...thread,
      })
    } finally {
      db.close()
    }
  })
  .get(
    '/work/:id/changes',
    zValidator('query', z.object({ path: z.string().min(1).optional() })),
    async (c) => {
      const found = findWork(c.req.param('id'))
      if (typeof found === 'string') {
        return found === 'bad-id'
          ? c.json({ error: 'not a work id' }, 400)
          : c.json({ error: 'no such work' }, 404)
      }
      const { entry } = found

      const path = c.req.valid('query').path
      if (path === undefined) {
        return c.json(
          await readChanges({ repo: entry.repo, branch: entry.branch }),
        )
      }
      if (entry.branch === null) {
        return c.json({ error: 'nothing was changed' }, 404)
      }
      const patch = await readFilePatch({
        repo: entry.repo,
        branch: entry.branch,
        path,
      })
      return patch === undefined
        ? c.json({ error: 'no such file in this change' }, 404)
        : c.json({ path, patch })
    },
  )
  .get(
    '/work/:id/artifact',
    zValidator('query', z.object({ artifact: z.string().min(1) })),
    async (c) => {
      const found = findWork(c.req.param('id'))
      if (typeof found === 'string') {
        return found === 'bad-id'
          ? c.json({ error: 'not a work id' }, 400)
          : c.json({ error: 'no such work' }, 404)
      }
      const id = c.req.valid('query').artifact
      // Parsed rather than prefix matched, for the same reason the tool does
      // it: an id is validated whole, so `acme__widgets/../other__repo/...`
      // cannot read its way out of this subject.
      const parsed = parseArtifactId(id)
      if (parsed?.repoSegment !== repoSegment(found.entry.repo)) {
        return c.json({ error: 'no such artifact' }, 404)
      }
      const body = await readArtifact(id)
      return body === undefined
        ? c.json({ error: 'no such artifact' }, 404)
        : c.json({ artifact: id, file: parsed.file, body })
    },
  )

/**
 * The run row a work id names, or why there is not one.
 *
 * Both detail routes start by turning an id into a row and both have the same
 * two ways of failing, so the lookup lives once and each route decides what to
 * do with the answer.
 */
function findWork(
  id: string,
): { entry: QueueEntry; subject: ParsedWorkId } | 'bad-id' | 'not-found' {
  const subject = parseWorkId(id)
  if (subject === undefined) {
    return 'bad-id'
  }
  const db = openState()
  try {
    const entry = readRun(db, subject.repo, subject.kind, subject.number)
    return entry === undefined ? 'not-found' : { entry, subject }
  } finally {
    db.close()
  }
}

function countByLane(items: readonly WorkItem[]): Record<Lane, number> {
  const counts = Object.fromEntries(LANES.map((lane) => [lane, 0])) as Record<
    Lane,
    number
  >
  for (const item of items) {
    counts[item.lane] += 1
  }
  return counts
}

/**
 * Which station is holding each running subject, read from the event buffer.
 *
 * The run row records that something is running and not who has it, because
 * the stage changes several times inside one row and writing each change would
 * be a database round trip per stage for a fact nothing durable needs. The
 * buffer already has it, keyed per run, so this reads the last stage entered.
 *
 * A run id is `repo#number@timestamp` and carries no subject kind, while the
 * database allows an issue and a pull request to share a number in one
 * repository. Two runs that collide on a key are therefore indistinguishable
 * from here, and the entry is dropped rather than guessed: no avatar letter is
 * better than the wrong station on both rows. The step events that arrive with
 * the thread carry their own station and this stops being inferred.
 */
/**
 * What each running station is in the middle of, folded from the buffer.
 *
 * The live store in the app fills from the stream and therefore knows nothing
 * about events that arrived before the page did. A step reporting every thirty
 * seconds would leave a freshly loaded page blank for thirty seconds, which
 * reads as a run that has stopped. This is the same reduction the app runs,
 * over the events the bus has retained, so a load starts where the run is.
 */
function runningActivity(): Map<string, SubjectActivity> {
  const bySubject = new Map<string, SubjectActivity>()
  for (const { runId } of activeRuns()) {
    const subject = activityKeyOfRun(runId)
    if (subject === '') {
      continue
    }
    const folded = replay(runId).reduce(advanceActivity, NO_ACTIVITY)
    if (folded !== NO_ACTIVITY) {
      bySubject.set(subject, folded)
    }
  }
  return bySubject
}

function runningStations(): Map<string, string> {
  const bySubject = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const { runId } of activeRuns()) {
    // Split from the end: the timestamp is appended last, and a repository
    // name may legally contain an at sign.
    const subject = activityKeyOfRun(runId)
    if (subject === '') {
      continue
    }
    if (bySubject.has(subject)) {
      ambiguous.add(subject)
      continue
    }
    const stage = lastStage(replay(runId))
    if (stage !== undefined) {
      bySubject.set(subject, stage)
    }
  }
  for (const subject of ambiguous) {
    bySubject.delete(subject)
  }
  return bySubject
}

/**
 * The stage a run is in, named as the rest of the interface names it.
 *
 * A row reading "analyst" beside a banner reading "Analyst is working" looks
 * like one of the two is broken, so both go through the same table. A stage
 * that is not a station keeps its own name.
 */
function lastStage(events: readonly RunEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'stage.entered') {
      return isStation(event.stage) ? stationName(event.stage) : event.stage
    }
  }
  return undefined
}

const STATIONS = ['classifier', 'analyst', 'implementer', 'reviewer'] as const

function isStation(stage: string): stage is StationId {
  return (STATIONS as readonly string[]).includes(stage)
}
