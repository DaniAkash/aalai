import { describe, expect, test } from 'bun:test'
import { stoppedBecause, watchingLine } from '@/shared/triageView'

/**
 * How a watched pull request reads.
 *
 * The rule the wording has to hold to is that none of it is a question.
 * Nothing is being asked of anybody while a watch is running, and a row that
 * reads like a request is one somebody tries to answer and cannot.
 */

const pr = { repo: 'acme/widgets', number: 31, ciFixes: 0, revisions: 0 }

describe('what it is doing', () => {
  test('says what is happening rather than asking anything', () => {
    for (const state of [
      'watching',
      'collecting',
      'classifyingFailure',
      'fixing',
      'saying',
    ]) {
      const line = watchingLine({ ...pr, state })
      expect(line).not.toContain('?')
      expect(line.toLowerCase()).not.toContain('approve')
    }
  })

  test('a repeated attempt says which one it is on', () => {
    expect(watchingLine({ ...pr, state: 'fixing', ciFixes: 2 })).toContain(
      'attempt 2',
    )
  })

  test('a first attempt does not number itself', () => {
    expect(watchingLine({ ...pr, state: 'fixing', ciFixes: 1 })).toBe(
      'fixing the checks',
    )
  })

  test('an unknown state still says something true', () => {
    expect(watchingLine({ ...pr, state: 'something-new' })).toContain(
      'watching',
    )
  })
})

describe('why it stopped', () => {
  test('a branch somebody touched names them', () => {
    expect(
      stoppedBecause({ kind: 'handedBack', author: 'a-maintainer' }),
    ).toContain('a-maintainer')
  })

  test('a spent budget says what was tried', () => {
    expect(
      stoppedBecause({
        kind: 'exhausted',
        why: 'the checks were fixed 2 times and are still failing',
      }),
    ).toContain('fixed 2 times')
  })

  test('a green pull request says so plainly', () => {
    expect(stoppedBecause({ kind: 'settled' })).toContain('green')
  })

  test('an outcome that recorded nothing admits it', () => {
    // Better than inventing a reason for a pull request somebody is looking at.
    expect(stoppedBecause({ kind: 'mystery' })).toContain('did not record')
  })
})
