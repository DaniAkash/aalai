import { describe, expect, test } from 'bun:test'
import { DOMAINS } from '@/modules/settings/domains'

describe('the stations domain', () => {
  test('a config written before this key existed still loads', () => {
    // The key is new. Every install that predates it has none, and a required
    // key here would stop the factory starting rather than degrade to the
    // behaviour it had yesterday.
    const parsed = DOMAINS.stations.parse({})
    expect(parsed.analyst).toEqual({ skills: [], instructions: '' })
    expect(parsed.reviewer).toEqual({ skills: [], instructions: '' })
  })

  test('one station being set leaves the others at their defaults', () => {
    const parsed = DOMAINS.stations.parse({
      analyst: { skills: ['gh-cli'], instructions: 'Ask first.' },
    })
    expect(parsed.analyst.skills).toEqual(['gh-cli'])
    expect(parsed.implementer.skills).toEqual([])
  })

  test('effort is absent rather than defaulted, so it can fall back', () => {
    // An absent value means "use the shared effort". Defaulting it here would
    // pin every station to one and silently ignore the shared setting.
    expect(DOMAINS.stations.parse({}).analyst.reasoningEffort).toBeUndefined()
  })
})
