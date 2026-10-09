/**
 * A unified diff, as rows a reader can be shown.
 *
 * Git speaks in hunks and the pane speaks in numbered lines, so something has
 * to count. Here rather than in the screen because getting the numbering wrong
 * is silent: the diff still renders, it just points at the wrong lines, and the
 * only way to catch that is a test over a patch whose numbers are known.
 */

export type PatchLineType = 'added' | 'removed' | 'context' | 'meta'

export interface PatchLine {
  readonly id: string
  readonly type: PatchLineType
  readonly oldLine?: number
  readonly newLine?: number
  readonly content: string
}

const HUNK = /^@@ -(?<old>\d+)(?:,\d+)? \+(?<new>\d+)(?:,\d+)? @@/

/**
 * Lines a reader does not need, dropped, and only where they can occur.
 *
 * The file header restates the filename the pane already shows as its heading,
 * and its `---`/`+++` pair would otherwise count as a removal and an addition
 * of the path itself.
 *
 * It is only consulted before the first hunk. Inside a hunk a removed line
 * whose own text begins with `-- ` is written `--- `, and treating that as a
 * header deletes a line of somebody's source and shifts every number after it.
 */
function isFileHeader(line: string): boolean {
  return (
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('new file mode') ||
    line.startsWith('deleted file mode') ||
    line.startsWith('similarity index') ||
    line.startsWith('rename from') ||
    line.startsWith('rename to')
  )
}

/**
 * What one line inside a hunk is, and what it contributes to the numbering.
 *
 * Only a leading space is context. Everything else unrecognised is metadata:
 * the no-newline marker, and the notices git emits in place of a binary body.
 * Reading an unknown first character as a marker invents a numbered row and
 * eats the first letter of the text.
 */
function classify(raw: string): { type: PatchLineType; content: string } {
  const marker = raw.charAt(0)
  if (marker === '+' || marker === '-' || marker === ' ') {
    const type =
      marker === '+' ? 'added' : marker === '-' ? 'removed' : 'context'
    return { type, content: raw.slice(1) }
  }
  return { type: 'meta', content: raw }
}

/**
 * Walks a patch, keeping the two line counters the hunk headers set.
 *
 * A small class rather than four variables threaded through helpers: the
 * counters and the position in the file are one thing, and separating them is
 * how a refactor ends up advancing one and not the other.
 */
class Numbering {
  private oldLine = 0
  private newLine = 0
  private index = 0
  inHunk = false

  startHunk(oldStart: number, newStart: number): void {
    this.inHunk = true
    this.oldLine = oldStart
    this.newLine = newStart
  }

  take(type: PatchLineType, content: string): PatchLine {
    const id = `l${this.index++}`
    const old = type === 'removed' || type === 'context'
    const next = type === 'added' || type === 'context'
    return {
      id,
      type,
      ...(old ? { oldLine: this.oldLine++ } : {}),
      ...(next ? { newLine: this.newLine++ } : {}),
      content,
    }
  }
}

export function parsePatch(patch: string): PatchLine[] {
  const out: PatchLine[] = []
  const at = new Numbering()

  for (const raw of patch.split('\n')) {
    if (!at.inHunk && isFileHeader(raw)) {
      continue
    }
    const hunk = HUNK.exec(raw)
    if (hunk?.groups !== undefined) {
      at.startHunk(Number(hunk.groups.old), Number(hunk.groups.new))
      out.push(at.take('meta', raw))
      continue
    }
    // A patch ends with a trailing newline, which splits into one empty string
    // that is not a context line and must not be numbered as one.
    if (raw === '' && out.length > 0) {
      continue
    }
    const { type, content } = at.inHunk
      ? classify(raw)
      : { type: 'meta' as const, content: raw }
    out.push(at.take(type, content))
  }
  return out
}

/**
 * The language to highlight a path as, by extension.
 *
 * A table rather than a switch: every entry is one fact and adding a language
 * to the bundle means adding a line here, not another branch.
 */
const LANGUAGES: Record<string, string> = {
  bash: 'bash',
  go: 'go',
  js: 'tsx',
  json: 'json',
  jsx: 'tsx',
  md: 'markdown',
  mjs: 'tsx',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  yaml: 'yaml',
  yml: 'yaml',
}

export function languageOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  // Not every file in a repository is a language the bundle carries, and a
  // missing grammar renders as nothing rather than as plain text.
  return LANGUAGES[ext] ?? 'text'
}
