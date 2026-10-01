/**
 * Reading a paginated REST response's envelope.
 *
 * Split out from the calls that use it so the parsing can be tested on its own:
 * these two functions are where an off by one page or a swallowed body would
 * come from, and neither is observable from the repository list itself.
 */

/**
 * Splits `gh api -i` output into its headers and its body.
 *
 * gh prints the status line, the headers, a blank line, then the body. The wire
 * uses CRLF and gh has been seen to normalise it, so both are accepted.
 */
export function splitResponse(out: string): {
  head: string
  body: string
} {
  const split = out.search(/\r?\n\r?\n/)
  if (split === -1) {
    return { head: '', body: out }
  }
  return {
    head: out.slice(0, split),
    body: out.slice(split).replace(/^\r?\n\r?\n/, ''),
  }
}

export function headerValue(head: string, name: string): string | undefined {
  const prefix = `${name.toLowerCase()}:`
  const line = head
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().startsWith(prefix))
  return line?.slice(prefix.length).trim()
}

/**
 * Reads one `rel` out of a Link header, as a page number.
 *
 * A page number rather than the URL, because the client re-asks through our own
 * route and never calls api.github.com itself. Without this the caller cannot
 * tell a short page from the last page, and either stops one page early or asks
 * for a page that does not exist.
 */
export function linkPage(
  link: string | undefined,
  rel: string,
): number | null {
  if (link === undefined || link === '') {
    return null
  }
  for (const part of link.split(',')) {
    if (!part.includes(`rel="${rel}"`)) {
      continue
    }
    const open = part.indexOf('<')
    const close = part.indexOf('>')
    if (open === -1 || close <= open) {
      continue
    }
    const url = part.slice(open + 1, close)
    const page = new URLSearchParams(url.split('?')[1] ?? '').get('page')
    if (page !== null && /^\d+$/.test(page)) {
      return Number(page)
    }
  }
  return null
}
