/**
 * Whether a diff is small enough for a verdict on it to mean anything.
 *
 * An honest refusal beats a confident rubber stamp on a three thousand line
 * change, and this is the cheapest possible place to decide: it counts lines
 * and spends no agent time, so a pull request nobody could review usefully is
 * declined before anything expensive happens.
 *
 * The numbers are a judgement rather than a discovery, and they are deliberately
 * generous. Refusing something reviewable wastes a person's patience; accepting
 * something unreviewable produces a verdict that reads exactly like a real one.
 */

/** Changed lines past which a single verdict stops being believable. */
const TOO_MANY_LINES = 1200
/** Files past which a change is doing several things at once. */
const TOO_MANY_FILES = 40

export interface DiffSize {
  readonly lines: number
  readonly files: number
}

export type Reviewability =
  | { readonly reviewable: true }
  | {
      readonly reviewable: false
      readonly reason: string
      /** Something a person can act on, rather than only a refusal. */
      readonly suggestion: string
    }

/** What a diff amounts to, counted from the text rather than asked of anybody. */
export function sizeOf(diff: string): DiffSize {
  let lines = 0
  let files = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      files += 1
      continue
    }
    // Only real changes. The +++ and --- headers start with a marker too, and
    // counting them would add two lines per file to every diff.
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      lines += 1
    }
  }
  return { lines, files }
}

/** Whether a verdict on this would be worth reading. */
export function isReviewable(size: DiffSize): Reviewability {
  if (size.files === 0) {
    return {
      reviewable: false,
      reason: 'there is nothing in this diff to review',
      suggestion:
        'If this is meant to change something, the branch may not be pushed.',
    }
  }
  if (size.lines > TOO_MANY_LINES) {
    return {
      reviewable: false,
      reason: `this changes ${size.lines} lines across ${size.files} files, which is more than can be reviewed in one pass with any confidence`,
      suggestion:
        'Splitting it along the seams of what it does, one concern per pull request, would get each part a real reading rather than all of it a glance.',
    }
  }
  if (size.files > TOO_MANY_FILES) {
    return {
      reviewable: false,
      reason: `this touches ${size.files} files, which usually means it is doing several unrelated things`,
      suggestion:
        'If one of those things is a rename or a reformat, landing that on its own first would leave a diff that shows the actual change.',
    }
  }
  return { reviewable: true }
}
