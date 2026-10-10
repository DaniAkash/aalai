import { describe, expect, test } from 'bun:test'
import { type ReviewThread, threadHolding } from '@/lib/ghReview'

// The shape GitHub actually returned for DaniAkash/aalai-demo#69, so the
// mapping is tested against a real response rather than an invented one.
const threads: ReviewThread[] = [
  {
    id: 'PRRT_kwDOUesxcs6qx8Wm',
    isResolved: false,
    commentIds: ['4230160456'],
  },
  {
    id: 'PRRT_second',
    isResolved: true,
    commentIds: ['5000001', '5000002'],
  },
]

describe('finding the thread a comment sits in', () => {
  test('a comment id maps to its thread', () => {
    // The whole reason this is a lookup: a thread node id is not derivable
    // from the comment id, and resolving needs the first while an answer
    // names the second.
    expect(threadHolding(threads, '4230160456')?.id).toBe(
      'PRRT_kwDOUesxcs6qx8Wm',
    )
  })

  test('a reply inside a thread finds the same thread as its opener', () => {
    // An answer may name a follow up rather than the comment that started the
    // thread. Matching only the first comment would leave it unable to resolve.
    expect(threadHolding(threads, '5000002')?.id).toBe('PRRT_second')
  })

  test('a review summary belongs to no thread', () => {
    // Its id is prefixed because it comes from a different table. Nothing
    // should be resolved for it, and that is a normal outcome.
    expect(threadHolding(threads, 'review:999')).toBeUndefined()
  })

  test('an id that is a prefix of another does not match it', () => {
    // String containment would make "500000" find "5000001" and resolve the
    // wrong thread.
    expect(threadHolding(threads, '500000')).toBeUndefined()
  })

  test('nothing is found in no threads', () => {
    expect(threadHolding([], '4230160456')).toBeUndefined()
  })
})
