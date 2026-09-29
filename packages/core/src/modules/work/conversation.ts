import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { artifactsDir, CONVERSATION, type Subject } from './paths'

/**
 * The subject's discussion, which is now written to by people as well as
 * stations.
 *
 * Entries used to be delimited by a `## author · timestamp` heading alone. A
 * station's output never began a line with `## `, so nothing had tripped over
 * it, but a person's reply plausibly does: one message would split into two,
 * the second attributed to whatever the heading said. The sentinel below cannot
 * be produced by markdown a person types, and a literal occurrence of it in a
 * body is escaped on write.
 *
 * The heading is still emitted so the file reads the way it always did, and the
 * parser still accepts entries that have only a heading, because files written
 * before this existed are the record and are not rewritten.
 */

/**
 * Who said it.
 *
 * A reporter is neither of the other two: they do not work here, so they cannot
 * approve anything, and the keeper deliberately only treats a maintainer's
 * words as a question a station owes an answer to.
 */
export type EntryRole = 'maintainer' | 'station' | 'reporter'

export interface ConversationEntry {
  /** Derived from the entry, not stored: the file has no ids in it. */
  readonly id: string
  readonly author: string
  readonly role: EntryRole
  readonly at: string
  readonly body: string
}

const OPEN = '<!-- aalai:entry'
const ESCAPED_OPEN = '<!-- aalai-quoted:entry'
/** Marks a line that already began with the escape marker before it was written. */
const QUOTE = '\u0021'
const SENTINEL_LINE =
  /^<!-- aalai:entry author="(?<author>[^"]*)" role="(?<role>maintainer|station)" at="(?<at>[^"]*)" -->$/
const HEADING_LINE = /^## (?<author>.+?) · (?<at>\d{4}-\d{2}-\d{2}T\S+)$/

/**
 * Neutralises a sentinel a body contains, so it cannot open an entry.
 *
 * The escape marker is escaped first, and unescaping reverses that order.
 * Rewriting only the open marker is not reversible: a body that already
 * contained the escaped form was left alone on the way in and promoted to the
 * open form on the way out, so a person's text came back changed.
 */
function escapeBody(body: string): string {
  return body
    .split('\n')
    .map((line) => {
      if (line.startsWith(ESCAPED_OPEN)) {
        return `${QUOTE}${line}`
      }
      return line.startsWith(OPEN) ? line.replace(OPEN, ESCAPED_OPEN) : line
    })
    .join('\n')
}

function unescapeBody(body: string): string {
  return body
    .split('\n')
    .map((line) => {
      if (line.startsWith(`${QUOTE}${ESCAPED_OPEN}`)) {
        return line.slice(QUOTE.length)
      }
      return line.startsWith(ESCAPED_OPEN)
        ? line.replace(ESCAPED_OPEN, OPEN)
        : line
    })
    .join('\n')
}

export function formatEntry(input: {
  author: string
  role: EntryRole
  at: string
  body: string
}): string {
  const author = input.author.replace(/"/g, "'")
  const head = `${OPEN} author="${author}" role="${input.role}" at="${input.at}" -->`
  return `\n${head}\n## ${input.author} · ${input.at}\n\n${escapeBody(input.body.trim())}\n`
}

/**
 * Appends to the subject's conversation.
 *
 * Append only because rewriting what was said is how a record stops being one.
 * Unversioned because a discussion has no versions.
 */
export async function appendEntry(
  subject: Subject,
  input: { author: string; role: EntryRole; body: string },
): Promise<ConversationEntry> {
  const dir = artifactsDir(subject)
  await mkdir(dir, { recursive: true })
  const at = new Date().toISOString()
  const body = input.body.trim()
  const path = join(dir, CONVERSATION)
  await appendFile(path, formatEntry({ ...input, at }), 'utf8')

  // Read back, because the id depends on the entry's position and only a read
  // knows what the parser will call it. Matched rather than taken from the end:
  // a station can append between this append and this read, and returning the
  // last entry then hands back somebody else's words, which the terminal echoes
  // as what you just said and the event stream announces under the wrong author.
  const entries = parseConversation(await Bun.file(path).text())
  const written = entries.findLast(
    (entry) =>
      entry.at === at && entry.author === input.author && entry.body === body,
  )
  return (
    written ?? {
      id: entryId(input.author, at, entries.length),
      author: input.author,
      role: input.role,
      at,
      body,
    }
  )
}

/**
 * The entries in a conversation, oldest first.
 *
 * Tolerates both forms because the old one is on disk in real installations. A
 * heading with no sentinel is a station entry: nothing else could have written
 * one before the sentinel existed.
 */
export function parseConversation(text: string): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  let current: EntryHead | undefined
  let body: string[] = []

  const flush = (): void => {
    if (current !== undefined) {
      entries.push({
        id: entryId(current.author, current.at, entries.length),
        author: current.author,
        role: current.role,
        at: current.at,
        body: unescapeBody(body.join('\n').trim()),
      })
    }
    body = []
  }

  // A bare heading delimits only until the first sentinel. The file is append
  // only and chronological, so every legacy entry precedes every sentinel one,
  // and after that point a heading-shaped line can only be someone's prose.
  let seenSentinel = false
  for (const line of withoutDecorativeHeadings(text.split('\n'))) {
    const head = matchHead(line, { headingsDelimit: !seenSentinel })
    if (head !== undefined) {
      seenSentinel = seenSentinel || head.fromSentinel
      flush()
      current = head
      continue
    }
    if (current !== undefined) {
      body.push(line)
    }
  }
  flush()
  return entries
}

interface EntryHead {
  readonly author: string
  readonly role: EntryRole
  readonly at: string
  /** Whether a sentinel opened this entry, rather than a legacy heading. */
  readonly fromSentinel: boolean
}

/**
 * Drops the heading that follows a sentinel.
 *
 * The heading is kept in the file so it still reads as prose, but it repeats
 * what the sentinel already said. Left in, it would be matched as a second
 * delimiter and open an empty entry.
 */
function withoutDecorativeHeadings(lines: readonly string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    kept.push(line)
    if (SENTINEL_LINE.test(line) && HEADING_LINE.test(lines[i + 1] ?? '')) {
      i += 1
    }
  }
  return kept
}

/** A line that starts an entry, in either accepted form, or nothing. */
function matchHead(
  line: string,
  options: { headingsDelimit: boolean },
): EntryHead | undefined {
  const sentinel = SENTINEL_LINE.exec(line)?.groups
  if (sentinel !== undefined) {
    return {
      author: sentinel.author ?? 'unknown',
      role: sentinel.role === 'maintainer' ? 'maintainer' : 'station',
      at: sentinel.at ?? '',
      fromSentinel: true,
    }
  }
  if (!options.headingsDelimit) {
    return undefined
  }
  const heading = HEADING_LINE.exec(line)?.groups
  if (heading !== undefined) {
    // Nothing but a station could have written a bare heading: the sentinel
    // existed before a person could append at all.
    return {
      author: heading.author ?? 'unknown',
      role: 'station',
      at: heading.at ?? '',
      fromSentinel: false,
    }
  }
  return undefined
}

/**
 * Stable without being stored.
 *
 * Position is in the id because author and timestamp are not enough: a station
 * appending twice inside one millisecond produced one id for two entries, which
 * dropped the second as already seen and made React reuse a key. The file is
 * append only, so an entry's position never changes once written.
 */
function entryId(author: string, at: string, index: number): string {
  return Bun.hash(`${index}|${author}|${at}`).toString(36)
}

/**
 * The subject's discussion as entries, or none if nothing has been said.
 *
 * Asks for the file and handles it not being there, rather than checking first
 * and then reading. The check reads as a guard and is not one: they are two
 * separate awaits, so a file that disappears between them makes the read throw
 * instead of producing the empty thread the check exists to produce. A gate
 * nobody has spoken at has no file at all, so absence is the ordinary case here
 * and not a failure.
 */
export async function readConversation(
  subject: Subject,
): Promise<ConversationEntry[]> {
  try {
    const text = await Bun.file(
      join(artifactsDir(subject), CONVERSATION),
    ).text()
    return parseConversation(text)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return []
    }
    throw error
  }
}
