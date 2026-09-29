import { describe, expect, test } from 'bun:test'
import { windowAroundFailure } from '@/lib/ghPr'

/**
 * Finding the part of a log that says why a check went red.
 *
 * The shape here is the one a real run produced: a long setup, the assertion
 * in the middle, and the job tidying up afterwards. Taking the end of that
 * gave forty lines of housekeeping and no mention of the failing test, which
 * is what this exists to stop.
 */

function log(): string {
  const setup = Array.from({ length: 150 }, (_, i) => `setup line ${i}`)
  const failure = [
    "5 |   expect([ordinal(1)]).toEqual(['1st'])",
    "9 |   expect([ordinal(11)]).toEqual(['11th'])",
    'error: expect(received).toEqual(expected)',
    '- Expected  - 3',
    '+ Received  + 3',
    '(fail) uses th for the teens [0.29ms]',
    ' 1 fail',
  ]
  const cleanup = Array.from({ length: 80 }, (_, i) => `Post job cleanup ${i}`)
  return [...setup, ...failure, ...cleanup].join('\n')
}

describe('the window around a failure', () => {
  test('carries the assertion', () => {
    expect(windowAroundFailure(log(), 60)).toContain(
      'expect(received).toEqual(expected)',
    )
  })

  test('and names the test that failed', () => {
    expect(windowAroundFailure(log(), 60)).toContain('uses th for the teens')
  })

  test('rather than the cleanup that followed it', () => {
    expect(windowAroundFailure(log(), 60)).not.toContain('Post job cleanup 79')
  })

  test('a log shorter than the cap is left whole', () => {
    expect(windowAroundFailure('one\ntwo\nthree', 60)).toBe('one\ntwo\nthree')
  })

  test('a log with nothing failure shaped still returns the cap', () => {
    const quiet = Array.from({ length: 300 }, (_, i) => `quiet ${i}`).join('\n')
    expect(windowAroundFailure(quiet, 60).split('\n')).toHaveLength(60)
  })

  test('a failure on the very last line still brings its context', () => {
    const tail = [
      ...Array.from({ length: 200 }, (_, i) => `line ${i}`),
      'error: it broke',
    ].join('\n')
    const kept = windowAroundFailure(tail, 30)
    expect(kept).toContain('error: it broke')
    expect(kept).toContain('line 199')
  })
})
