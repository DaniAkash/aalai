import { describe, expect, test } from 'bun:test'
import { planSteps } from '@/shared/planSteps'

const PLAN = `# Plan

## Problem

formatBytes compares against the wrong bound.

## Approach

Divide while the value is at or above the unit size.

## Steps

1. Correct the comparison in the unit loop
2. Round to one decimal place rather than truncating
3. Run the test suite

## Acceptance criteria

1. formatBytes(1024) returns "1 KB"
2. formatBytes(1023) returns "1023 B"
`

describe('planSteps', () => {
  test('reads the steps, in order', () => {
    expect(planSteps(PLAN)).toEqual([
      'Correct the comparison in the unit loop',
      'Round to one decimal place rather than truncating',
      'Run the test suite',
    ])
  })

  test('stops at the next heading, so criteria are not steps', () => {
    // The two lists look identical in markdown. Reading past the heading
    // would give five steps and show the wrong one as running.
    expect(planSteps(PLAN)).toHaveLength(3)
  })

  test('the criteria can be read on their own', () => {
    expect(planSteps(PLAN, 'Acceptance criteria')).toHaveLength(2)
  })

  test('position is the index, not the number in the document', () => {
    // A step index counts from zero down the list. An agent that numbers its
    // plan 1, 2, 4 still has three steps rather than a hole at three.
    expect(planSteps('## Steps\n1. a\n2. b\n4. c\n')).toEqual(['a', 'b', 'c'])
  })

  test('accepts the other numbering punctuation', () => {
    expect(planSteps('## Steps\n1) a\n2) b\n')).toEqual(['a', 'b'])
  })

  test('a plan with no steps section is empty, not an error', () => {
    expect(planSteps('# Plan\n\nJust prose.\n')).toEqual([])
  })

  test('prose inside the section is not a step', () => {
    expect(
      planSteps('## Steps\n\nThese are the steps.\n\n1. only this\n'),
    ).toEqual(['only this'])
  })
})
