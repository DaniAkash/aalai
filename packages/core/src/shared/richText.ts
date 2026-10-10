/**
 * Splitting prose from fenced code, before either is rendered.
 *
 * The reason this exists rather than letting a markdown renderer handle code
 * itself: everything here is written by strangers and bots, so prose is
 * rendered by sanitising html, and code must never take that path. Pulling
 * fences out first means code reaches the highlighter as the text it is, and
 * the sanitiser only ever sees prose.
 *
 * Derived from text, so it is tested before anything draws from it. A splitter
 * that loses the last block, or mistakes an indented fence for prose, produces
 * a page that looks plausible and is missing what somebody wrote.
 */

export interface ProseSegment {
  readonly kind: 'prose'
  readonly text: string
  /** Where it starts in the body, which is what makes it identifiable. */
  readonly offset: number
}

export interface CodeSegment {
  readonly kind: 'code'
  readonly text: string
  /** What the fence was labelled, lowercased. Empty when it was not. */
  readonly language: string
  /** Where it starts in the body, which is what makes it identifiable. */
  readonly offset: number
}

export type RichSegment = ProseSegment | CodeSegment

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*$/

interface Fence {
  readonly marker: string
  readonly language: string
}

/** The fence a line opens or closes, when it is one. */
function fenceOn(line: string): Fence | undefined {
  const found = FENCE.exec(line)
  if (found === null) {
    return undefined
  }
  return {
    marker: found[2] ?? '```',
    language: (found[3] ?? '').toLowerCase(),
  }
}

/**
 * Whether this line ends the block that `marker` opened.
 *
 * The same character and at least as many of them, and no language, which is
 * what lets a block containing a shorter fence be written with a longer one
 * without ending early on its own contents.
 */
function closes(fence: Fence | undefined, marker: string): boolean {
  return (
    fence !== undefined &&
    fence.language === '' &&
    fence.marker.startsWith(marker.charAt(0)) &&
    fence.marker.length >= marker.length
  )
}

/**
 * One body, as alternating prose and code.
 *
 * A fence closes on the same character it opened with and at least as many of
 * them, which is what lets a block containing backticks be written with more.
 * An unclosed fence runs to the end rather than being discarded, because the
 * half written block is still what the author typed.
 */
export function splitRichText(body: string): RichSegment[] {
  const out: RichSegment[] = []
  const lines = body.split('\n')
  let prose: string[] = []
  let code: string[] | null = null
  let marker = ''
  let language = ''
  // Counted rather than searched for, because two identical blocks in one
  // body are different blocks and a key made from their text would collide.
  let cursor = 0
  let proseAt = 0
  let codeAt = 0

  const flushProse = () => {
    const text = prose.join('\n').trim()
    if (text !== '') {
      out.push({ kind: 'prose', text, offset: proseAt })
    }
    prose = []
  }

  for (const line of lines) {
    const lineAt = cursor
    cursor += line.length + 1
    const fence = fenceOn(line)

    if (code !== null) {
      if (closes(fence, marker)) {
        out.push({
          kind: 'code',
          text: code.join('\n'),
          language,
          offset: codeAt,
        })
        code = null
      } else {
        code.push(line)
      }
      continue
    }
    if (fence !== undefined) {
      flushProse()
      codeAt = lineAt
      code = []
      marker = fence.marker
      language = fence.language
      continue
    }
    if (prose.length === 0) {
      proseAt = lineAt
    }
    prose.push(line)
  }

  if (code !== null) {
    // Unclosed. Kept rather than dropped: a half written block is still what
    // the author typed, and losing it silently is worse than showing it.
    out.push({
      kind: 'code',
      text: code.join('\n'),
      language,
      offset: codeAt,
    })
  } else {
    flushProse()
  }
  return out
}
