import { describe, expect, test } from 'bun:test'
import { titleFromBrief } from '@/shared/brief'

describe('titleFromBrief', () => {
  test('a short brief is its own title', () => {
    expect(titleFromBrief('formatBytes is off by one')).toBe(
      'formatBytes is off by one',
    )
  })

  test('the first sentence, when there are several', () => {
    expect(
      titleFromBrief(
        'formatBytes is off by one. It returns bytes where it should return kilobytes.',
      ),
    ).toBe('formatBytes is off by one.')
  })

  test('the first line, when there are several', () => {
    expect(
      titleFromBrief('Fix the picker\n\nIt only lists my own repos.'),
    ).toBe('Fix the picker')
  })

  test('a full stop inside a word does not end the sentence', () => {
    // Otherwise a brief mentioning a file is titled after half its name.
    expect(titleFromBrief('src/bytes.ts rounds the wrong way')).toBe(
      'src/bytes.ts rounds the wrong way',
    )
  })

  test('a question mark ends it too', () => {
    expect(
      titleFromBrief('Should clamp return the lower bound? I think so.'),
    ).toBe('Should clamp return the lower bound?')
  })

  test('a long title is cut at a word, not mid word', () => {
    // A title ending mid word reads as a bug in this app rather than a long
    // title that had to be shortened.
    const title = titleFromBrief(
      'The repository picker only lists repositories I own and I want it to reach everything the account can see',
    )
    expect(title.length).toBeLessThanOrEqual(75)
    expect(title.endsWith('...')).toBe(true)
    expect(title).not.toMatch(/\s\.\.\.$/)
    // The cut landed on a word boundary, so the last word is a whole one.
    expect('everything the account can see').not.toContain(
      title.replace('...', '').split(' ').pop() ?? '',
    )
  })

  test('an empty brief still has a title', () => {
    // The route rejects an empty brief, but a title function that returns an
    // empty string would create an issue GitHub shows as untitled.
    expect(titleFromBrief('   \n  ')).toBe('Untitled work')
  })

  test('surrounding whitespace is not part of the title', () => {
    expect(titleFromBrief('\n\n  Fix the picker  \n')).toBe('Fix the picker')
  })
})
