import { describe, expect, test } from 'bun:test'
import { headerValue, linkPage, splitResponse } from '@/lib/ghLink'

/**
 * Paging is where a repository list goes quietly wrong: it stops one page
 * early, or asks for a page past the end, and in both cases the list simply
 * looks shorter rather than broken. These are the two functions that decide
 * it, so they are tested on the exact shapes GitHub sends rather than on a
 * simplified version of them.
 */

// Copied from a real response rather than written by hand, because the parts
// that break parsing are the ones nobody would invent: the percent encoded
// commas inside a qualifier, and the comma that separates the two rels.
const REAL_LINK =
  '<https://api.github.com/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&per_page=3&page=2&sort=pushed>; rel="next", <https://api.github.com/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&per_page=3&page=124&sort=pushed>; rel="last"'

describe('reading the page numbers out of a Link header', () => {
  test('finds the next page', () => {
    expect(linkPage(REAL_LINK, 'next')).toBe(2)
  })

  test('finds the last page, which is what makes a total knowable', () => {
    expect(linkPage(REAL_LINK, 'last')).toBe(124)
  })

  test('a rel that is not there is null rather than a guess', () => {
    expect(linkPage(REAL_LINK, 'prev')).toBeNull()
  })

  test('the last page carries prev and no next, which is how paging stops', () => {
    const link =
      '<https://api.github.com/user/repos?page=123>; rel="prev", <https://api.github.com/user/repos?page=1>; rel="first"'
    expect(linkPage(link, 'next')).toBeNull()
    expect(linkPage(link, 'prev')).toBe(123)
  })

  test('no header at all means no next page', () => {
    // A single page response carries no Link header. Treating that as "more"
    // would make the list fetch forever.
    expect(linkPage(undefined, 'next')).toBeNull()
    expect(linkPage('', 'next')).toBeNull()
  })

  test('a malformed header does not throw, it declines to page', () => {
    expect(linkPage('garbage; rel="next"', 'next')).toBeNull()
    expect(linkPage('<https://x/?page=abc>; rel="next"', 'next')).toBeNull()
  })
})

describe('splitting headers from the body', () => {
  test('CRLF, which is what the wire actually uses', () => {
    const raw = 'HTTP/2.0 200 OK\r\nLink: <x>; rel="next"\r\n\r\n[{"a":1}]'
    const { head, body } = splitResponse(raw)
    expect(headerValue(head, 'link')).toBe('<x>; rel="next"')
    expect(JSON.parse(body)).toEqual([{ a: 1 }])
  })

  test('LF, because gh has been seen to normalise it', () => {
    const raw = 'HTTP/2.0 200 OK\nLink: <x>; rel="next"\n\n[{"a":1}]'
    const { head, body } = splitResponse(raw)
    expect(headerValue(head, 'link')).toBe('<x>; rel="next"')
    expect(JSON.parse(body)).toEqual([{ a: 1 }])
  })

  test('a body containing a blank line survives', () => {
    // The split is on the FIRST blank line. A later one belongs to the body and
    // taking it instead would truncate the JSON.
    const raw = 'HTTP/2.0 200 OK\r\n\r\n{"body":"one\\n\\ntwo"}'
    const { body } = splitResponse(raw)
    expect(JSON.parse(body)).toEqual({ body: 'one\n\ntwo' })
  })

  test('header lookup is case insensitive, since HTTP/2 lowercases them', () => {
    const { head } = splitResponse('HTTP/2.0 200 OK\r\nlink: <x>\r\n\r\n[]')
    expect(headerValue(head, 'Link')).toBe('<x>')
  })

  test('no headers at all is treated as a bare body', () => {
    const { body } = splitResponse('[{"a":1}]')
    expect(JSON.parse(body)).toEqual([{ a: 1 }])
  })

  test('a header that is absent is undefined, not empty string', () => {
    const { head } = splitResponse('HTTP/2.0 200 OK\r\n\r\n[]')
    expect(headerValue(head, 'link')).toBeUndefined()
  })
})
