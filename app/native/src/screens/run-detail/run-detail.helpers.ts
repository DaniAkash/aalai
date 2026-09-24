import type { RunEvent } from 'aalai-core/events'

export const STATIONS = [
  'analyst',
  'implementer',
  'reviewer',
  'deliver',
] as const
export type Station = (typeof STATIONS)[number]

export type StationState = 'waiting' | 'working' | 'done'

/**
 * How far along the belt a run has got.
 *
 * Read from the events rather than stored, because the events are what the run
 * actually said. A stage that has been entered and then left is done; the last
 * one entered is working.
 */
export function stationStates(
  events: readonly RunEvent[],
): Record<Station, StationState> {
  const entered = events
    .filter((event) => event.type === 'stage.entered')
    .map((event) => event.stage)
  const finished = events.some(
    (event) =>
      event.type === 'run.delivered' ||
      event.type === 'run.failed' ||
      event.type === 'run.stopped',
  )
  const last = entered.at(-1)

  const states = {} as Record<Station, StationState>
  for (const station of STATIONS) {
    const seen = entered.includes(station)
    states[station] =
      seen && station === last && !finished
        ? 'working'
        : seen
          ? 'done'
          : 'waiting'
  }
  return states
}

/** The acceptance criteria, once the analyst has written them. */
export function criteriaOf(events: readonly RunEvent[]): readonly string[] {
  const analysis = events.findLast((event) => event.type === 'analysis.ready')
  return analysis?.criteria ?? []
}

/** What the reviewer said about each of them, once it has. */
export function verdictOf(events: readonly RunEvent[]) {
  return events.findLast((event) => event.type === 'review.verdict')
}

/** The line a person reads to know how this ended, or that it has not. */
export function outcomeOf(events: readonly RunEvent[]): string {
  const last = events.findLast(
    (event) =>
      event.type === 'run.delivered' ||
      event.type === 'run.failed' ||
      event.type === 'run.stopped',
  )
  if (last === undefined) {
    return 'in flight'
  }
  if (last.type === 'run.delivered') {
    return `delivered ${last.prUrl}`
  }
  return last.type === 'run.failed'
    ? `failed: ${last.error}`
    : `stopped: ${last.reason}`
}
