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

function started(stepIndex: number): RunEvent {
  return {
    type: 'step.started',
    runId: RUN,
    at: 1_000,
    station: 'implementer',
    stepIndex,
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
    expect(state.finished.has(0)).toBe(true)
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
    expect(state.finished.has(0)).toBe(true)
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

  test('the reduction does not mutate what it was given', () => {
    const first = fold([started(0)])
    const second = advanceActivity(first, finished(0))
    expect(first.finished.size).toBe(0)
    expect(second.finished.size).toBe(1)
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
