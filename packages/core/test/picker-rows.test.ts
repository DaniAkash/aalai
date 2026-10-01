import { describe, expect, test } from 'bun:test'
import {
  flattenRows,
  pinnedHeader,
  pushedLabel,
  rowHeight,
  starsLabel,
} from '@/shared/pickerRows'

/**
 * The picker groups a few hundred repositories by owner inside one virtualized
 * list, which means the grouping is an array transform rather than nested
 * markup. These are the rules that transform has to keep, because a wrong one
 * shows up as a header in the wrong place rather than as an error.
 */

function repo(full: string, ownerType: 'user' | 'org' = 'user') {
  const owner = full.split('/')[0] ?? ''
  return {
    repo: full,
    owner,
    ownerType,
    isPrivate: false,
    pushedAt: '',
    language: '',
    stars: 0,
  }
}

describe('grouping repositories into one flat array', () => {
  test('each owner gets exactly one header, above its own repositories', () => {
    const rows = flattenRows(
      [repo('me/a'), repo('me/b'), repo('acme/c', 'org')],
      ['me', 'acme'],
    )
    expect(rows.map((r) => r.key)).toEqual([
      'h:me',
      'me/a',
      'me/b',
      'h:acme',
      'acme/c',
    ])
  })

  test('owner order follows the server, so the account sits above its orgs', () => {
    // Arrival order deliberately puts the organization first, which is what
    // sorting by last push actually does.
    const rows = flattenRows(
      [repo('acme/c', 'org'), repo('me/a')],
      ['me', 'acme'],
    )
    expect(rows[0]).toMatchObject({ kind: 'header', owner: 'me' })
  })

  test('repositories keep their arrival order inside an owner', () => {
    // The server sorts by most recent push. Re-sorting here would throw that
    // away and the list would stop being "what is alive first".
    const rows = flattenRows([repo('me/z'), repo('me/a')], ['me'])
    expect(rows.map((r) => r.key)).toEqual(['h:me', 'me/z', 'me/a'])
  })

  test('an owner the server did not list still appears, at the end', () => {
    // Reachable through a team rather than through membership. Dropping it
    // would hide a repository the account can genuinely act on.
    const rows = flattenRows([repo('stranger/x', 'org'), repo('me/a')], ['me'])
    expect(rows.map((r) => r.key)).toEqual([
      'h:me',
      'me/a',
      'h:stranger',
      'stranger/x',
    ])
  })

  test('no repositories means no headers rather than empty sections', () => {
    expect(flattenRows([], ['me', 'acme'])).toEqual([])
  })

  test('the two row kinds have different heights, which the virtualizer needs', () => {
    const rows = flattenRows([repo('me/a')], ['me'])
    expect(rowHeight(rows[0] as never)).toBe(34)
    expect(rowHeight(rows[1] as never)).toBe(52)
  })
})

describe('which header is pinned', () => {
  const rows = flattenRows(
    [repo('me/a'), repo('me/b'), repo('acme/c', 'org')],
    ['me', 'acme'],
  )

  test('inside a section, that section is pinned', () => {
    expect(pinnedHeader(rows, 2)).toMatchObject({ owner: 'me' })
  })

  test('landing exactly on a header pins that header, not the previous one', () => {
    expect(pinnedHeader(rows, 3)).toMatchObject({ owner: 'acme' })
  })

  test('an index past the end pins the last header rather than throwing', () => {
    expect(pinnedHeader(rows, 99)).toMatchObject({ owner: 'acme' })
  })

  test('an empty list pins nothing', () => {
    expect(pinnedHeader([], 0)).toBeUndefined()
  })
})

describe('the labels on a row', () => {
  test('one star is singular', () => {
    expect(starsLabel(1)).toBe('1 star')
    expect(starsLabel(2)).toBe('2 stars')
  })

  test('thousands are abbreviated, because the column is narrow', () => {
    expect(starsLabel(13_784)).toBe('13.8k stars')
  })

  test('no stars says nothing at all rather than zero', () => {
    expect(starsLabel(0)).toBe('')
  })

  test('push dates degrade from days to months to years', () => {
    const ago = (days: number) =>
      new Date(Date.now() - days * 86_400_000).toISOString()
    expect(pushedLabel(ago(0))).toBe('pushed today')
    expect(pushedLabel(ago(1))).toBe('pushed yesterday')
    expect(pushedLabel(ago(9))).toBe('pushed 9d ago')
    expect(pushedLabel(ago(70))).toBe('pushed 2mo ago')
    expect(pushedLabel(ago(800))).toBe('pushed 2y ago')
  })

  test('a missing or unparseable date renders nothing, not Invalid Date', () => {
    expect(pushedLabel('')).toBe('')
    expect(pushedLabel('not a date')).toBe('')
  })
})
