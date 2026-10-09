import { describe, expect, test } from 'bun:test'
import type { RunEvent } from '@/events/events.types'
import {
  activityKey,
  activityKeyOfRun,
  advanceActivity,
  NO_ACTIVITY,
  type SubjectActivity,
  stationName,
} from '@/shared/stepActivity'

const RUN = 'DaniAkash/aalai-demo#61@1790000000061'

function started(stepIndex: number, label?: string): RunEvent {
  return {
    type: 'step.started',
    runId: RUN,
    at: 1_000,
    station: 'implementer',
    stepIndex,
    ...(label === undefined ? {} : { label }),
  }
}

function progress(stepIndex: number, done: number, total = 68): RunEvent {
  return {
    type: 'step.progress',
    runId: RUN,
    at: 2_000,
    station: 'implementer',
    stepIndex,
    label: 'bun test',
    unit: 'files',
    done,
    total,
  }
}

function finished(stepIndex: number, summary = 'done'): RunEvent {
  return {
    type: 'step.finished',
    runId: RUN,
    at: 3_000,
    station: 'implementer',
    stepIndex,
    summary,
    files: [],
  }
}

function fold(events: readonly RunEvent[]): SubjectActivity {
  return events.reduce(advanceActivity, NO_ACTIVITY)
}

describe('advanceActivity', () => {
  test('a started step becomes the live one', () => {
    const state = fold([started(0)])
    expect(state.live?.stepIndex).toBe(0)
    expect(state.live?.station).toBe('implementer')
    expect(state.live?.progress).toBeUndefined()
  })

  test('progress attaches to the step that reported it', () => {
    const state = fold([started(1), progress(1, 17)])
    expect(state.live?.progress).toEqual({
      label: 'bun test',
      unit: 'files',
      done: 17,
      total: 68,
    })
  })

  test('progress rises without resetting the start time', () => {
    const state = fold([started(1), progress(1, 17), progress(1, 41)])
    expect(state.live?.progress?.done).toBe(41)
    expect(state.live?.startedAt).toBe(1_000)
  })

  test('a finished step clears the live one rather than parking it full', () => {
    // A bar left at 100% reads as a step that is still running and has
    // stopped moving, which is the exact impression this feature exists to
    // avoid giving.
    const state = fold([started(0), progress(0, 68), finished(0)])
    expect(state.live).toBeNull()
    expect(state.finished).toContain(0)
  })

  test('finishing keeps what the step said it did', () => {
    const state = fold([finished(2, '68 test files pass')])
    expect(state.lastSummary).toBe('68 test files pass')
  })

  test('finished steps accumulate across a run', () => {
    const state = fold([
      started(0),
      finished(0),
      started(1),
      finished(1),
      started(2),
    ])
    expect([...state.finished].sort()).toEqual([0, 1])
    expect(state.live?.stepIndex).toBe(2)
  })

  test('finishing an older step leaves the newer one running', () => {
    // Events can arrive out of order over a reconnect. A late finish for a
    // step already overtaken must not blank the step now running.
    const state = fold([started(0), started(1), finished(0)])
    expect(state.live?.stepIndex).toBe(1)
    expect(state.finished).toContain(0)
  })

  test('progress with no start still shows, for a screen opened mid run', () => {
    const state = fold([progress(3, 5, 10)])
    expect(state.live?.stepIndex).toBe(3)
    expect(state.live?.progress?.done).toBe(5)
  })

  test('a late report from an overtaken step is ignored', () => {
    // Otherwise the display rewinds to the older step and its count.
    const state = fold([
      started(1),
      progress(1, 40),
      started(2),
      progress(1, 41),
    ])
    expect(state.live?.stepIndex).toBe(2)
    expect(state.live?.progress).toBeUndefined()
  })

  test('events that are not steps change nothing', () => {
    const state = fold([
      started(0),
      {
        type: 'gate.opened',
        runId: RUN,
        at: 9,
        gateId: `${RUN}:plan`,
        repo: 'DaniAkash/aalai-demo',
        issue: 61,
        kind: 'plan',
        summary: undefined,
      },
    ])
    expect(state.live?.stepIndex).toBe(0)
  })

  test('a step keeps the name the station gave it', () => {
    // The work list has no plan to look a step up in, so the name travels
    // with the event.
    const state = fold([started(0, 'Run the test suite')])
    expect(state.live?.label).toBe('Run the test suite')
  })

  test('a step with no name has none, rather than an empty one', () => {
    // The caller falls back to the plan or the number; an empty string would
    // render as a blank line that looks like a layout bug.
    const state = fold([started(0)])
    expect(state.live?.label).toBeUndefined()
  })

  test('progress does not erase the name the start gave it', () => {
    const state = fold([started(1, 'Run the test suite'), progress(1, 17)])
    expect(state.live?.label).toBe('Run the test suite')
    expect(state.live?.progress?.done).toBe(17)
  })

  test('finishing the same step twice records it once', () => {
    // A reconnect can redeliver. The plan should not show two ticks for one
    // step, and the array must not grow without bound.
    const state = fold([finished(0), finished(0)])
    expect(state.finished).toEqual([0])
  })

  test('the finished list survives a round trip through json', () => {
    // It crosses the wire to seed a freshly loaded page. A Set serializes to
    // an empty object, which would silently un-tick every step.
    const state = fold([started(0), finished(0), started(1), finished(1)])
    const wire = JSON.parse(JSON.stringify(state)) as typeof state
    expect(wire.finished).toEqual([0, 1])
  })

  test('the reduction does not mutate what it was given', () => {
    const first = fold([started(0)])
    const second = advanceActivity(first, finished(0))
    expect(first.finished).toHaveLength(0)
    expect(second.finished).toHaveLength(1)
  })
})

describe('activity keys', () => {
  test('a run id and a subject agree', () => {
    expect(activityKeyOfRun(RUN)).toBe(activityKey('DaniAkash/aalai-demo', 61))
  })

  test('a repo name containing an at sign still keys on the last one', () => {
    // The timestamp is appended last, so the split has to come from the end.
    expect(activityKeyOfRun('scope/at@once#4@1790000000061')).toBe(
      'scope/at@once#4',
    )
  })
})

describe('stationName', () => {
  test('names every station', () => {
    // Record over the union, so a new station is a type error here rather
    // than an empty banner at run time.
    expect(stationName('implementer')).toBe('Implementer')
    expect(stationName('classifier')).toBe('Triage')
    expect(stationName('analyst')).toBe('Analyst')
    expect(stationName('reviewer')).toBe('Reviewer')
  })
})
