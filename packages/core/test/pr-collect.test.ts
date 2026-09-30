import { describe, expect, test } from 'bun:test'
import { add, type Collecting, open, ready, upshotOf } from '@/run/prCollect'
import type { Signal } from '@/run/prSignals'

/**
 * One revision at a time, and what a batch of signals amounts to.
 *
 * The case this exists for is a reviewer commenting while a check is failing.
 * Two revisions against one branch both start from the same commit and the
 * second undoes the first.
 */

const comments: Signal = { kind: 'comments', comments: [] }
const failed: Signal = { kind: 'checks_failed', names: ['test'] }
const moved: Signal = { kind: 'base_moved', baseSha: 'base2' }
const touched: Signal = { kind: 'branch_touched', author: 'a-maintainer' }

const T0 = '2026-01-01T00:00:00.000Z'
const at = (ms: number) => Date.parse(T0) + ms

describe('the window', () => {
  test('is not ready the moment it opens', () => {
    expect(ready(open(T0, failed), at(0))).toBe(false)
  })

  test('is ready once it has been open long enough', () => {
    expect(ready(open(T0, failed), at(90_000))).toBe(true)
  })

  test('is measured from when it opened, not from the last signal', () => {
    // Otherwise a stream of comments keeps pushing the window back and the
    // revision never starts.
    let batch = open(T0, failed)
    batch = add(batch, comments)
    batch = add(batch, comments)
    expect(ready(batch, at(90_000))).toBe(true)
  })

  test('survives being reconstructed, because it is a timestamp', () => {
    // A restart mid window must not wait the whole window again.
    const restored: Collecting = { openedAt: T0, signals: [failed] }
    expect(ready(restored, at(91_000))).toBe(true)
  })
})

describe('what a batch amounts to', () => {
  test('a comment and a failure together are one revision', () => {
    const batch = add(open(T0, failed), comments)
    const upshot = upshotOf(batch)
    expect(upshot.kind).toBe('revise')
    expect(upshot.kind === 'revise' && upshot.failing).toEqual(['test'])
    expect(upshot.kind === 'revise' && upshot.asked).toHaveLength(1)
  })

  test('somebody else touching the branch stops everything', () => {
    // Even beside a failure we would otherwise fix: the answer to a failure is
    // a push, and this is the one signal that forbids one.
    const batch = add(add(open(T0, failed), comments), touched)
    expect(upshotOf(batch)).toEqual({ kind: 'stop', author: 'a-maintainer' })
  })

  test('a moved base is rebased before the work is redone', () => {
    // Revising against the old base produces a diff that will not apply.
    const batch = add(open(T0, failed), moved)
    expect(upshotOf(batch)).toEqual({ kind: 'rebase', baseSha: 'base2' })
  })

  test('two failures in one window are one revision naming both', () => {
    const batch = add(open(T0, failed), {
      kind: 'checks_failed',
      names: ['lint'],
    })
    const upshot = upshotOf(batch)
    expect(upshot.kind === 'revise' && upshot.failing).toEqual(['test', 'lint'])
  })

  test('a window holding nothing actionable asks for nothing', () => {
    expect(upshotOf({ openedAt: T0, signals: [] })).toEqual({ kind: 'nothing' })
  })

  test('a passing check on its own is not a revision', () => {
    expect(upshotOf(open(T0, { kind: 'checks_passed' }))).toEqual({
      kind: 'nothing',
    })
  })
})
