/**
 * Terminal output meant for a person, as opposed to the factory's structured log.
 *
 * logger() serves the running factory: levelled, scoped and greppable, and it
 * holds that shape whether or not anyone is watching. This serves someone who
 * typed a command and is waiting on the answer, so it is free to use colour,
 * alignment and tables. Keeping the two apart is also why the console ban can
 * stay on everywhere else: this is the one module that writes for a reader.
 */

import chalk from 'chalk'
import Table from 'cli-table3'
import symbols from 'log-symbols'
import terminalLink from 'terminal-link'

function write(line: string): void {
  // biome-ignore lint/suspicious/noConsole: the single sanctioned terminal write, see the module docstring
  console.log(line)
}

function suffix(detail: string | undefined): string {
  return detail === undefined ? '' : ` ${chalk.dim(detail)}`
}

/** A blank line then a bold title, to separate sections of a command's output. */
export function heading(text: string): void {
  write(`\n${chalk.bold(text)}`)
}

/** A satisfied check. */
export function ok(label: string, detail?: string): void {
  write(`${symbols.success} ${label}${suffix(detail)}`)
}

/** A failed check. */
export function bad(label: string, detail?: string): void {
  write(`${symbols.error} ${label}${suffix(detail)}`)
}

/** A neutral fact, neither pass nor fail. */
export function note(label: string, detail?: string): void {
  write(`${chalk.dim('·')} ${label}${suffix(detail)}`)
}

/** Indented passthrough for output produced by another tool. */
export function block(text: string): void {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return
  }
  for (const line of trimmed.split('\n')) {
    write(`  ${chalk.dim(line)}`)
  }
}

/**
 * Widest a single column may grow before its contents wrap.
 *
 * Without a ceiling one long error drags the whole table past the terminal and
 * every other row wraps into noise.
 */
const MAX_COLUMN = 44

function columnWidths(
  head: readonly string[],
  rows: readonly (readonly string[])[],
): number[] {
  return head.map((title, index) => {
    const cells = rows.map((row) => row[index]?.length ?? 0)
    return Math.min(Math.max(title.length, ...cells), MAX_COLUMN) + 2
  })
}

/** Aligned columns, for a listing long enough that alignment helps. */
export function table(
  head: readonly string[],
  rows: readonly (readonly string[])[],
): void {
  const rendered = new Table({
    head: head.map((cell) => chalk.dim(cell)),
    style: { head: [], border: [] },
    colWidths: columnWidths(head, rows),
    wordWrap: true,
    // A url has no spaces, so word-boundary wrapping would truncate it and
    // leave an address nobody can copy. Breaking mid-token keeps it whole.
    wrapOnWordBoundary: false,
  })
  for (const row of rows) {
    rendered.push([...row])
  }
  write(rendered.toString())
}

/**
 * A hyperlink where the terminal supports one, and the bare URL where it does
 * not, so the address stays copyable rather than collapsing to a dead label.
 */
export function link(label: string, url: string): string {
  return terminalLink(label, url, { fallback: () => url })
}
