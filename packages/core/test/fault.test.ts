import { describe, expect, test } from 'bun:test'
import {
  type FaultVerdict,
  faultSchema,
  isOurFault,
} from '@/run/stations/schemas'

/**
 * Deciding whether a failing check is this change's fault.
 *
 * Written before the station that produces one. The asymmetry below is the
 * whole point of the step existing, and it is the kind of thing that gets
 * quietly reversed by somebody making the code read more naturally.
 */

function verdict(overrides: Partial<FaultVerdict> = {}): FaultVerdict {
  return faultSchema.parse({
    fault: 'ours',
    summary: 'the new branch of slugify drops the separator',
    reasoning: 'the failing assertion names the function this change edited',
    evidence: ['expected "a-b", received "ab"'],
    ...overrides,
  })
}

describe('spending a fix', () => {
  test('is allowed when the change caused it', () => {
    expect(isOurFault(verdict({ fault: 'ours' }))).toBe(true)
  })

  test('is not allowed when somebody else did', () => {
    expect(isOurFault(verdict({ fault: 'theirs' }))).toBe(false)
  })

  test('is not allowed when nobody can tell', () => {
    // The asymmetry this step exists for. Wrong this way leaves a pull request
    // open with an honest comment on it. Wrong the other way rewrites working
    // code against a failure it did not cause, twice, then gives up.
    expect(isOurFault(verdict({ fault: 'unclear' }))).toBe(false)
  })
})

describe('what a verdict has to carry', () => {
  test('a fault outside the three is refused rather than coerced', () => {
    expect(() => verdict({ fault: 'maybe' as never })).toThrow()
  })

  test('evidence is required, so a verdict cannot be a bare opinion', () => {
    expect(() =>
      faultSchema.parse({
        fault: 'ours',
        summary: 's',
        reasoning: 'r',
      }),
    ).toThrow()
  })

  test('evidence handed back grouped is still read', () => {
    const parsed = faultSchema.parse({
      fault: 'theirs',
      summary: 's',
      reasoning: 'r',
      evidence: { runner: ['could not reach the registry'] },
    })
    expect(parsed.evidence.length).toBeGreaterThan(0)
  })
})
