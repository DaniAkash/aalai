import { Hono } from 'hono'
import { loadConfig } from '@/config'
import { activeRuns, replay } from '@/events/bus'
import type { RunEvent } from '@/events/events.types'
import { listQueue, runningCount } from '@/modules/runs/queue'
import {
  LANES,
  type Lane,
  laneOf,
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
export const workRoute = new Hono().get('/work', async (c) => {
  const repo = c.req.query('repo')
  const config = await loadConfig()
  const db = openState()
  try {
    const stations = runningStations()
    const items = listQueue(db)
      .filter((entry) => repo === undefined || entry.repo === repo)
      .map((entry): WorkItem => {
        const subject = `${entry.repo}#${entry.number}`
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
          station: stations.get(subject) ?? null,
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
 * Keyed by subject rather than run id: a row is addressed by repository and
 * number, and a run id carries a start timestamp the list never sees.
 */
function runningStations(): Map<string, string> {
  const bySubject = new Map<string, string>()
  for (const { runId } of activeRuns()) {
    const subject = runId.split('@')[0]
    const stage = subject === undefined ? undefined : lastStage(replay(runId))
    if (subject !== undefined && stage !== undefined) {
      bySubject.set(subject, stage)
    }
  }
  return bySubject
}

function lastStage(events: readonly RunEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'stage.entered') {
      return event.stage
    }
  }
  return undefined
}
