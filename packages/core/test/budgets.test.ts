import { describe, expect, test } from 'bun:test'
import {
  type Allowance,
  exhaustedBecause,
  mayFixCi,
  mayRevise,
} from '@/run/budgets'

/**
 * The two allowances, and the reason they are two.
 *
 * A single counter is the obvious implementation and is wrong in a way nobody
 * notices until a correct pull request is abandoned because somebody else's
 * runner had a bad morning.
 */

const allowance: Allowance = { maxCiFixes: 2, maxRevisions: 2 }

describe('spending one does not spend the other', () => {
  test('a pull request out of ci fixes may still be revised', () => {
    const spent = { ciFixes: 2, revisions: 0 }
    expect(mayFixCi(spent, allowance)).toBe(false)
    expect(mayRevise(spent, allowance)).toBe(true)
  })

  test('and one out of revisions may still have its checks fixed', () => {
    const spent = { ciFixes: 0, revisions: 2 }
    expect(mayRevise(spent, allowance)).toBe(false)
    expect(mayFixCi(spent, allowance)).toBe(true)
  })

  test('both drain independently to their own limits', () => {
    expect(mayFixCi({ ciFixes: 1, revisions: 2 }, allowance)).toBe(true)
    expect(mayFixCi({ ciFixes: 2, revisions: 2 }, allowance)).toBe(false)
  })

  test('an allowance of zero means never, not once', () => {
    const none: Allowance = { maxCiFixes: 0, maxRevisions: 0 }
    expect(mayFixCi({ ciFixes: 0, revisions: 0 }, none)).toBe(false)
    expect(mayRevise({ ciFixes: 0, revisions: 0 }, none)).toBe(false)
  })
})

describe('saying why it stopped', () => {
  test('names the one that ran out', () => {
    expect(exhaustedBecause({ ciFixes: 2, revisions: 0 }, allowance)).toContain(
      'checks were fixed 2 times',
    )
    expect(exhaustedBecause({ ciFixes: 0, revisions: 2 }, allowance)).toContain(
      'revised 2 times',
    )
  })

  test('says nothing while there is budget left', () => {
    expect(exhaustedBecause({ ciFixes: 1, revisions: 1 }, allowance)).toBe(
      undefined,
    )
  })

  test('and says nothing when a zero allowance was never spent', () => {
    // Nothing was tried, so "it was fixed 0 times and is still failing" would
    // be a sentence about something that never happened.
    const none: Allowance = { maxCiFixes: 0, maxRevisions: 0 }
    expect(exhaustedBecause({ ciFixes: 0, revisions: 0 }, none)).toBe(undefined)
  })
})
