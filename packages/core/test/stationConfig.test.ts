import { describe, expect, test } from 'bun:test'
import type { Config } from '@/config'
import type { StationId } from '@/events/events.types'
import { DOMAINS } from '@/modules/settings/domains'
import { effortFor, stationExtras } from '@/run/stationExtras'

const STATIONS: readonly StationId[] = [
  'classifier',
  'analyst',
  'implementer',
  'reviewer',
]

function configWith(stations: Record<string, unknown>): Config {
  return {
    reasoningEffort: 'high',
    stations: DOMAINS.stations.parse(stations),
  } as Config
}

describe('stationExtras', () => {
  test('a station nobody configured adds nothing', () => {
    // The default for every station, so this is what most runs look like.
    expect(stationExtras({ skills: [], instructions: '' })).toBe('')
    expect(stationExtras(undefined)).toBe('')
  })

  test('skills are named, and said to belong to this station alone', () => {
    const extras = stationExtras({ skills: ['gh-cli'], instructions: '' })
    expect(extras).toContain('gh-cli')
    expect(extras).toContain('not to the others')
  })

  test('instructions that are only whitespace are not instructions', () => {
    // Otherwise clearing the field leaves a blank paragraph in the prompt.
    expect(stationExtras({ skills: [], instructions: '   \n ' })).toBe('')
  })
})

describe('a skill belongs to one station', () => {
  const config = configWith({
    analyst: { skills: ['repo-conventions'], instructions: 'Ask first.' },
  })

  test('only the configured station is handed it', () => {
    // The acceptance criterion, checked against what each station is handed
    // rather than against the form that sets it. Every station turn goes
    // through one place, so this is every turn and not only the first.
    const handed = Object.fromEntries(
      STATIONS.map((station) => [
        station,
        stationExtras(config.stations[station]),
      ]),
    )
    expect(handed.analyst).toContain('repo-conventions')
    expect(handed.analyst).toContain('Ask first.')
    for (const other of ['classifier', 'implementer', 'reviewer']) {
      expect(handed[other]).toBe('')
    }
  })

  test('the classifier is configurable like the rest', () => {
    // It is on the settings page, so it has to reach the run. A station shown
    // as editable whose settings go nowhere is worse than one not shown.
    const triage = configWith({ classifier: { skills: ['severity-rubric'] } })
    expect(stationExtras(triage.stations.classifier)).toContain(
      'severity-rubric',
    )
    expect(stationExtras(triage.stations.analyst)).toBe('')
  })
})

describe('effortFor', () => {
  test('a station with no answer follows the shared setting', () => {
    const config = configWith({})
    for (const station of STATIONS) {
      expect(effortFor(config, station)).toBe('high')
    }
  })

  test('a station with its own answer overrides the shared one', () => {
    const config = configWith({ implementer: { reasoningEffort: 'low' } })
    expect(effortFor(config, 'implementer')).toBe('low')
    expect(effortFor(config, 'analyst')).toBe('high')
  })
})
