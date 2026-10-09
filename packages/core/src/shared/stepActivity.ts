import type { RunEvent, StationId } from '@/events/events.types'

export type { StationId }

/**
 * What a station is doing right now, reduced from the event stream.
 *
 * Everything else the interface shows has a durable home and is read back from
 * it. Progress has none: `step.progress` fires several times a second and is
 * never written down, so this is derived from the events themselves. Pure, and
 * here rather than in the app, because a reduction over a sequence is exactly
 * the thing worth testing and the app has no test runner.
 */

export interface StepActivity {
  readonly station: StationId
  readonly stepIndex: number
  readonly startedAt: number
  /** Absent until the step reports a count of its own. */
  readonly progress?: {
    readonly label: string
    readonly unit: string
    readonly done: number
    readonly total: number
  }
}

export interface SubjectActivity {
  readonly live: StepActivity | null
  /** Steps this run has finished, so the plan can tick them off. */
  readonly finished: ReadonlySet<number>
  /** The last thing a step said it did. */
  readonly lastSummary: string | null
}

export const NO_ACTIVITY: SubjectActivity = {
  live: null,
  finished: new Set(),
  lastSummary: null,
}

/**
 * The key an event and a screen can both produce.
 *
 * A run id is `repo#number@startedAt` and a screen knows only its subject, so
 * the timestamp is the part they cannot share and is dropped. Two runs on one
 * subject therefore share a key, which is what the interface wants: the newer
 * one is what is happening.
 */
export function activityKey(repo: string, issue: number): string {
  return `${repo}#${issue}`
}

export function activityKeyOfRun(runId: string): string {
  return runId.slice(0, runId.lastIndexOf('@'))
}

/** One event folded into the activity for its subject. */
export function advanceActivity(
  current: SubjectActivity,
  event: RunEvent,
): SubjectActivity {
  if (event.type === 'step.started') {
    return {
      ...current,
      live: {
        station: event.station,
        stepIndex: event.stepIndex,
        startedAt: event.at,
      },
    }
  }
  if (event.type === 'step.progress') {
    return withProgress(current, event)
  }
  if (event.type === 'step.finished') {
    const finished = new Set(current.finished)
    finished.add(event.stepIndex)
    return {
      // The live step is cleared rather than left full. A bar that stays at
      // 100% reads as a step still running that has stopped moving.
      live: current.live?.stepIndex === event.stepIndex ? null : current.live,
      finished,
      lastSummary: event.summary,
    }
  }
  return current
}

function withProgress(
  current: SubjectActivity,
  event: Extract<RunEvent, { type: 'step.progress' }>,
): SubjectActivity {
  // A count for a step that never announced itself still counts: a screen
  // opened mid run sees progress before it sees a start.
  const live: StepActivity = current.live ?? {
    station: event.station,
    stepIndex: event.stepIndex,
    startedAt: event.at,
  }
  // A late report from a step that has already been overtaken is ignored
  // rather than rewinding the display to the older step.
  if (live.stepIndex !== event.stepIndex) {
    return current
  }
  return {
    ...current,
    live: {
      ...live,
      progress: {
        label: event.label,
        unit: event.unit,
        done: event.done,
        total: event.total,
      },
    },
  }
}

const NAMES: Record<StationId, string> = {
  classifier: 'Triage',
  analyst: 'Analyst',
  implementer: 'Implementer',
  reviewer: 'Reviewer',
}

/**
 * A station's name as a sentence uses it.
 *
 * The id is lowercase and reads fine in a metadata row, but the banner says
 * "<name> is working", and "implementer is working" reads as a typo.
 */
export function stationName(station: StationId): string {
  return NAMES[station]
}
