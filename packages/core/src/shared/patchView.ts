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
 * Lines a reader does not need, dropped.
 *
 * The `diff --git`, `index`, `---` and `+++` lines restate the filename the
 * pane already shows as its heading, and the `---`/`+++` pair would otherwise
 * be counted as a removal and an addition of the path itself.
 */
function isHeader(line: string): boolean {
  return (
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file mode') ||
    line.startsWith('deleted file mode') ||
    line.startsWith('similarity index') ||
    line.startsWith('rename from') ||
    line.startsWith('rename to')
  )
}

export function parsePatch(patch: string): PatchLine[] {
  const out: PatchLine[] = []
  let oldLine = 0
  let newLine = 0
  let index = 0

  for (const raw of patch.split('\n')) {
    if (isHeader(raw)) {
      continue
    }
    const hunk = HUNK.exec(raw)
    if (hunk?.groups !== undefined) {
      oldLine = Number(hunk.groups.old)
      newLine = Number(hunk.groups.new)
      out.push({
        id: `l${index++}`,
        type: 'meta',
        content: raw,
      })
      continue
    }
    // A patch ends with a trailing newline, which splits into one empty
    // string that is not a context line and must not be numbered as one.
    if (raw === '' && out.length > 0) {
      continue
    }
    const marker = raw.charAt(0)
    const content = raw.slice(1)
    if (marker === '+') {
      out.push({
        id: `l${index++}`,
        type: 'added',
        newLine: newLine++,
        content,
      })
    } else if (marker === '-') {
      out.push({
        id: `l${index++}`,
        type: 'removed',
        oldLine: oldLine++,
        content,
      })
    } else if (marker === '\\') {
      // "\ No newline at end of file" belongs to the line above and numbers
      // nothing of its own.
      out.push({ id: `l${index++}`, type: 'meta', content: raw })
    } else {
      out.push({
        id: `l${index++}`,
        type: 'context',
        oldLine: oldLine++,
        newLine: newLine++,
        content,
      })
    }
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
