import { describe, expect, test } from 'bun:test'
import { splitRichText } from '@/shared/richText'

describe('splitting prose from code', () => {
  test('prose with no fence is one segment', () => {
    const out = splitRichText('Just a sentence.\n\nAnd another.')
    expect(out).toEqual([
      { kind: 'prose', text: 'Just a sentence.\n\nAnd another.', offset: 0 },
    ])
  })

  test('a fence becomes its own segment, with its language', () => {
    const out = splitRichText('Before.\n\n```ts\nconst a = 1\n```\n\nAfter.')
    expect(out.map((s) => s.kind)).toEqual(['prose', 'code', 'prose'])
    expect(out[1]).toMatchObject({
      kind: 'code',
      text: 'const a = 1',
      language: 'ts',
    })
  })

  test('a fence with no language still splits', () => {
    const out = splitRichText('```\nplain\n```')
    expect(out[0]).toMatchObject({ kind: 'code', text: 'plain', language: '' })
  })

  test('the last block is not lost', () => {
    // The classic off by one in a splitter: everything after the final fence
    // falls out and the page looks fine without it.
    const out = splitRichText('Before.\n\n```\ncode\n```\n\nThe last word.')
    expect(out.at(-1)).toMatchObject({ kind: 'prose', text: 'The last word.' })
  })

  test('an unclosed fence is kept, not dropped', () => {
    // A half written block is still what the author typed. Dropping it loses
    // the thing they were in the middle of saying.
    const out = splitRichText('Here:\n\n```ts\nconst a = 1')
    expect(out.map((s) => s.kind)).toEqual(['prose', 'code'])
    expect(out[1]).toMatchObject({ text: 'const a = 1' })
  })

  test('a longer fence survives a shorter one inside it', () => {
    // How somebody writes a code block that itself contains a fence. Closing
    // on the first three backticks would cut it in half.
    const out = splitRichText('````md\n```ts\nx\n```\n````')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ text: '```ts\nx\n```', language: 'md' })
  })

  test('tildes open and close a fence too', () => {
    const out = splitRichText('~~~python\nx = 1\n~~~')
    expect(out[0]).toMatchObject({ language: 'python', text: 'x = 1' })
  })

  test('a tilde does not close a backtick fence', () => {
    // Different characters are different fences. Treating them as one would
    // end a block on a line of tildes that is part of its contents.
    const out = splitRichText('```\na\n~~~\nb\n```')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ text: 'a\n~~~\nb' })
  })

  test('an empty body produces nothing', () => {
    expect(splitRichText('')).toEqual([])
    expect(splitRichText('   \n  ')).toEqual([])
  })

  test('a language label is lowercased, so TS and ts are one thing', () => {
    expect(splitRichText('```TS\nx\n```')[0]).toMatchObject({ language: 'ts' })
  })

  test('an indented fence still opens, up to three spaces', () => {
    // Markdown allows it, and a fence inside a list item is indented.
    expect(splitRichText('   ```ts\nx\n   ```')[0]).toMatchObject({
      kind: 'code',
    })
  })
})

describe('where a segment starts', () => {
  test('each segment knows its offset in the body', () => {
    // The offset is the identity. Two identical fences in one body are two
    // different blocks, so a key made from their text would collide and React
    // would reuse one for the other.
    const body = 'One.\n\n```\nx\n```\n\nTwo.\n\n```\nx\n```'
    const out = splitRichText(body)
    const offsets = out.map((s) => s.offset)
    expect(new Set(offsets).size).toBe(offsets.length)
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
  })

  test('an offset points at where the text really is', () => {
    const body = 'Before.\n\n```ts\nconst a = 1\n```'
    const out = splitRichText(body)
    expect(body.slice(out[0]?.offset ?? 0, 7)).toBe('Before.')
    expect(body.slice(out[1]?.offset ?? 0).startsWith('```ts')).toBe(true)
  })
})
