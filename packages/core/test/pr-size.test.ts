import { describe, expect, test } from 'bun:test'
import { isReviewable, sizeOf } from '@/run/prSize'

/**
 * Declining to review something too large.
 *
 * The point is the refusal being honest rather than the threshold being right.
 * A verdict on a three thousand line diff reads exactly like a verdict on a
 * three line one, which is what makes the confident version worse than saying
 * no.
 */

/** A diff in the shape `gh pr diff` produces. */
function diff(
  files: { path: string; added: number; removed: number }[],
): string {
  return files
    .flatMap((file) => [
      `diff --git a/${file.path} b/${file.path}`,
      'index 1111111..2222222 100644',
      `--- a/${file.path}`,
      `+++ b/${file.path}`,
      '@@ -1,3 +1,3 @@',
      ...Array.from({ length: file.added }, (_, i) => `+added ${i}`),
      ...Array.from({ length: file.removed }, (_, i) => `-removed ${i}`),
    ])
    .join('\n')
}

describe('counting a diff', () => {
  test('counts changed lines and files', () => {
    const size = sizeOf(diff([{ path: 'a.ts', added: 3, removed: 2 }]))
    expect(size).toEqual({ lines: 5, files: 1 })
  })

  test('does not count the file headers as changes', () => {
    // The +++ and --- lines start with a marker too, and counting them would
    // add two lines to every file in every diff.
    const size = sizeOf(diff([{ path: 'a.ts', added: 1, removed: 0 }]))
    expect(size.lines).toBe(1)
  })

  test('counts several files', () => {
    const size = sizeOf(
      diff([
        { path: 'a.ts', added: 1, removed: 1 },
        { path: 'b.ts', added: 1, removed: 1 },
      ]),
    )
    expect(size).toEqual({ lines: 4, files: 2 })
  })

  test('an empty diff is nothing, not one file', () => {
    expect(sizeOf('')).toEqual({ lines: 0, files: 0 })
  })
})

describe('deciding whether to give a verdict', () => {
  test('an ordinary change is reviewable', () => {
    expect(isReviewable({ lines: 40, files: 3 })).toEqual({ reviewable: true })
  })

  test('an enormous one is declined, and says how large', () => {
    const verdict = isReviewable({ lines: 3000, files: 12 })
    expect(verdict.reviewable).toBe(false)
    expect(verdict.reviewable === false && verdict.reason).toContain('3000')
  })

  test('and suggests something rather than only refusing', () => {
    // A refusal a person can do nothing with is a refusal that gets ignored.
    const verdict = isReviewable({ lines: 3000, files: 12 })
    expect(verdict.reviewable === false && verdict.suggestion).toContain(
      'Splitting it',
    )
  })

  test('a change touching very many files is declined even when small', () => {
    // Usually a rename or a reformat carrying a real change inside it.
    const verdict = isReviewable({ lines: 80, files: 200 })
    expect(verdict.reviewable).toBe(false)
    expect(verdict.reviewable === false && verdict.reason).toContain(
      '200 files',
    )
  })

  test('an empty diff is declined for a different reason than a large one', () => {
    const verdict = isReviewable({ lines: 0, files: 0 })
    expect(verdict.reviewable === false && verdict.reason).toContain('nothing')
  })

  test('the boundary is not off by one in the refusing direction', () => {
    // Refusing something reviewable wastes a person's patience, so the
    // threshold is the first value that is too large rather than the last that
    // is acceptable.
    expect(isReviewable({ lines: 1200, files: 5 }).reviewable).toBe(true)
    expect(isReviewable({ lines: 1201, files: 5 }).reviewable).toBe(false)
  })
})

describe('a changed line that looks like a header', () => {
  test('an added line whose content starts with ++ is counted', () => {
    // A unified diff renders it as `+++...`, so matching the marker without a
    // space swallowed it, and enough of those would let an oversized change slip
    // under the limit.
    const sneaky = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,3 @@',
      '+++i',
      '+++j',
      '+ordinary',
    ].join('\n')
    expect(sizeOf(sneaky).lines).toBe(3)
  })

  test('a removed line starting with -- is counted too', () => {
    const sneaky = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,1 @@',
      '---count-me',
      '-ordinary',
    ].join('\n')
    expect(sizeOf(sneaky).lines).toBe(2)
  })

  test('and the real headers are still not counted', () => {
    const plain = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,1 @@',
      '+one',
    ].join('\n')
    expect(sizeOf(plain).lines).toBe(1)
  })

  test('a diff made of them cannot hide its size', () => {
    // The shape of the bypass: many lines, none of them counted before.
    const many = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,2000 @@',
      ...Array.from({ length: 2000 }, (_, i) => `+++value${i}`),
    ].join('\n')
    expect(isReviewable(sizeOf(many)).reviewable).toBe(false)
  })
})
