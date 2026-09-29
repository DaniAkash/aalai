import { describe, expect, test } from 'bun:test'
import {
  checksSettled,
  type Look,
  type Seen,
  seenAfter,
  signalsFrom,
} from '@/run/prSignals'

/**
 * What counts as new about a pull request.
 *
 * Nothing pushes to a desktop application, so every fact here is a comparison
 * against the last look. The failures that matter are the ones where something
 * is reported twice, or not at all.
 */

const SEEN: Seen = {
  headSha: 'aaa',
  lastCommentId: 10,
  baseSha: 'base1',
  failedChecks: [],
  pushedSha: 'aaa',
}

function check(name: string, conclusion: string | null, status = 'completed') {
  return { name, status, conclusion, id: 1, html_url: 'u' }
}

function comment(id: number, author: string) {
  return {
    id,
    body: 'please change this',
    author,
    path: 'src/x.ts',
    line: 1,
    created_at: '2026-01-01T00:00:00Z',
    in_reply_to_id: null,
  }
}

function look(overrides: Partial<Look> = {}): Look {
  return {
    headSha: 'aaa',
    headAuthor: 'aalai',
    baseSha: 'base1',
    checks: [],
    comments: [],
    me: 'aalai',
    ...overrides,
  }
}

describe('a failure is reported once', () => {
  test('a failing check on a new commit is news', () => {
    const signals = signalsFrom(
      SEEN,
      look({ checks: [check('test', 'failure')] }),
    )
    expect(signals).toEqual([{ kind: 'checks_failed', names: ['test'] }])
  })

  test('the same failure on the same commit is not news twice', () => {
    const after = { ...SEEN, failedChecks: ['test'] }
    expect(
      signalsFrom(after, look({ checks: [check('test', 'failure')] })),
    ).toEqual([])
  })

  test('but the same check failing on a new commit is', () => {
    // A result belongs to a commit. Having seen this check fail on the old one
    // says nothing about the change that replaced it.
    // Pushed by us, so this is our new commit rather than somebody else's.
    const after = { ...SEEN, failedChecks: ['test'], pushedSha: 'bbb' }
    const signals = signalsFrom(
      after,
      look({ headSha: 'bbb', checks: [check('test', 'failure')] }),
    )
    expect(signals).toEqual([{ kind: 'checks_failed', names: ['test'] }])
  })

  test('a second check failing alongside a known one is news on its own', () => {
    const after = { ...SEEN, failedChecks: ['test'] }
    const signals = signalsFrom(
      after,
      look({ checks: [check('test', 'failure'), check('lint', 'failure')] }),
    )
    expect(signals).toEqual([{ kind: 'checks_failed', names: ['lint'] }])
  })
})

describe('a verdict is only a verdict once the run has finished', () => {
  test('a check still going is not a failure', () => {
    const signals = signalsFrom(
      SEEN,
      look({
        checks: [check('test', 'failure'), check('lint', null, 'in_progress')],
      }),
    )
    expect(signals).toEqual([])
  })

  test('and is not a pass either', () => {
    expect(
      checksSettled([
        check('test', null, 'in_progress'),
        check('lint', 'success'),
      ]),
    ).toBe(false)
  })

  test('no checks at all is not a settled pass', () => {
    // A repository with no workflows would otherwise look permanently green.
    expect(checksSettled([])).toBe(false)
  })
})

describe('who said it', () => {
  test('somebody else commenting is a signal', () => {
    const signals = signalsFrom(
      SEEN,
      look({ comments: [comment(11, 'a-maintainer')] }),
    )
    expect(signals).toEqual([
      { kind: 'comments', comments: [comment(11, 'a-maintainer')] },
    ])
  })

  test('our own comment is not somebody asking for something', () => {
    expect(
      signalsFrom(SEEN, look({ comments: [comment(11, 'aalai')] })),
    ).toEqual([])
  })

  test('a comment already handled is not handled again', () => {
    expect(
      signalsFrom(SEEN, look({ comments: [comment(9, 'a-maintainer')] })),
    ).toEqual([])
  })
})

describe('the branch, and the base under it', () => {
  test('a head we did not push is somebody else, whatever it says', () => {
    // The dependable check. On a personal repository the factory pushes as the
    // same account the maintainer commits as, so the author matches ours and a
    // hand written commit would otherwise be invisible.
    const signals = signalsFrom(
      SEEN,
      look({ headSha: 'bbb', headAuthor: 'aalai' }),
    )
    expect(signals[0]?.kind).toBe('branch_touched')
  })

  test('a head we did push is not', () => {
    const signals = signalsFrom(
      { ...SEEN, pushedSha: 'bbb' },
      look({ headSha: 'bbb', headAuthor: 'aalai' }),
    )
    expect(signals.some((s) => s.kind === 'branch_touched')).toBe(false)
  })

  test('a commit by somebody else is reported before anything else', () => {
    // Every other signal ends in a push, and this one forbids pushing, so it
    // has to be seen first rather than alongside.
    const signals = signalsFrom(
      SEEN,
      look({
        headAuthor: 'a-maintainer',
        headSha: 'bbb',
        checks: [check('test', 'failure')],
      }),
    )
    expect(signals[0]).toEqual({
      kind: 'branch_touched',
      author: 'a-maintainer',
    })
  })

  test('the base moving is its own signal', () => {
    expect(signalsFrom(SEEN, look({ baseSha: 'base2' }))).toEqual([
      { kind: 'base_moved', baseSha: 'base2' },
    ])
  })

  test('the base standing still is not', () => {
    expect(signalsFrom(SEEN, look())).toEqual([])
  })
})

describe('what is remembered afterwards', () => {
  test('a reported failure is not reported again', () => {
    const l = look({ checks: [check('test', 'failure')] })
    const next = seenAfter(SEEN, l, signalsFrom(SEEN, l))
    expect(signalsFrom(next, l)).toEqual([])
  })

  test('a new commit forgets the old commit’s failures', () => {
    const first = look({ checks: [check('test', 'failure')] })
    const next = {
      ...seenAfter(SEEN, first, signalsFrom(SEEN, first)),
      // What a revision does: push, then record what was pushed.
      pushedSha: 'bbb',
    }
    const second = look({ headSha: 'bbb', checks: [check('test', 'failure')] })
    expect(signalsFrom(next, second)).toEqual([
      { kind: 'checks_failed', names: ['test'] },
    ])
  })

  test('a handled comment is not handled again', () => {
    const l = look({ comments: [comment(11, 'a-maintainer')] })
    const next = seenAfter(SEEN, l, signalsFrom(SEEN, l))
    expect(signalsFrom(next, l)).toEqual([])
  })
})
