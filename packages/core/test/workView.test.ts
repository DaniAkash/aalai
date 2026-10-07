import { describe, expect, test } from 'bun:test'
import { laneOf, parseWorkId, workId } from '@/shared/workView'

/**
 * A work id goes into a url and comes back as a route param, so the only
 * property that matters is that it survives the trip for names GitHub
 * actually allows.
 */
describe('workId', () => {
  const repos = [
    'DaniAkash/aalai',
    // Underscores are legal in a repository name and were what broke the
    // first separator, so this is the case the test exists for.
    'DaniAkash/my_repo',
    'owner/repo.js',
    'a/b-c_d.e',
    'octo-org/a.very_long-name.v2',
  ]

  for (const repo of repos) {
    test(`round trips ${repo}`, () => {
      const id = workId({ repo, kind: 'issue', number: 7 })
      expect(parseWorkId(id)).toEqual({ repo, kind: 'issue', number: 7 })
    })
  }

  test('carries the kind', () => {
    const id = workId({ repo: 'a/b', kind: 'pr', number: 33 })
    expect(parseWorkId(id)?.kind).toBe('pr')
  })

  test('is a single url path segment', () => {
    const id = workId({ repo: 'DaniAkash/aalai', kind: 'issue', number: 1 })
    expect(id).not.toInclude('/')
    expect(encodeURIComponent(id)).toBe(id)
  })

  test('refuses anything that is not one', () => {
    for (const bad of [
      '',
      'nope',
      'a~b~issue',
      'a~b~branch~1',
      'a~b~issue~x',
    ]) {
      expect(parseWorkId(bad)).toBeUndefined()
    }
  })
})

describe('laneOf', () => {
  test('separates work nobody has started from work the machine is holding', () => {
    expect(laneOf('offered')).toBe('offered')
    expect(laneOf('queued')).toBe('queued')
  })

  test('sends every ending that is not delivery to one lane', () => {
    expect(laneOf('delivered')).toBe('done')
    expect(laneOf('failed')).toBe('failed')
    expect(laneOf('stopped')).toBe('failed')
    expect(laneOf('skipped')).toBe('failed')
  })

  test('a blocked run is waiting on a person, not on the machine', () => {
    expect(laneOf('blocked')).toBe('needsyou')
  })
})
