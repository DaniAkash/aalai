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

describe('planSteps against hostile input', () => {
  test('a line padded between its words does not stall the parse', () => {
    // Content, then a long run of spaces, then one more character. The first
    // version of these patterns captured lazily and ended in optional
    // whitespace, so it retried the tail at every expansion: 1673ms on this
    // input against 0.02ms now, and quadratic, so it only gets worse. A plan
    // is written by an agent, so its shape is not ours to assume.
    const pad = ' '.repeat(60_000)
    const hostile = `## a${pad}b\n1. a${pad}b\n`
    const started = performance.now()
    planSteps(hostile)
    expect(performance.now() - started).toBeLessThan(100)
  })

  test('a step that is only whitespace is not a step', () => {
    // It would render as a blank row that looks like a layout fault.
    expect(planSteps('## Steps\n1.    \n2. real\n')).toEqual(['real'])
  })

  test('surrounding whitespace is not kept', () => {
    expect(planSteps('##   Steps  \n1.   padded   \n')).toEqual(['padded'])
  })
})
