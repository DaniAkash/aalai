import { describe, expect, test } from 'bun:test'
import { languageOf, parsePatch } from '@/shared/patchView'

const PATCH = `diff --git a/src/ordinal.ts b/src/ordinal.ts
index 3d204cc..2776806 100644
--- a/src/ordinal.ts
+++ b/src/ordinal.ts
@@ -1,2 +1,4 @@
 /** Returns the ordinal suffix form. */
-export const ordinal = (n: number): string => \`\${n}th\`
+export const ordinal = (n: number): string => {
+  return suffix(n)
+}
`

describe('parsePatch', () => {
  const lines = parsePatch(PATCH)

  test('drops the header, which restates the filename the pane shows', () => {
    const content = lines.map((l) => l.content).join('\n')
    expect(content).not.toContain('diff --git')
    expect(content).not.toContain('index 3d204cc')
    expect(content).not.toContain('--- a/src')
  })

  test('numbers the old side only on lines the old side has', () => {
    const removed = lines.filter((l) => l.type === 'removed')
    expect(removed).toHaveLength(1)
    expect(removed[0]?.oldLine).toBe(2)
    expect(removed[0]?.newLine).toBeUndefined()
  })

  test('numbers the new side consecutively across added lines', () => {
    expect(
      lines.filter((l) => l.type === 'added').map((l) => l.newLine),
    ).toEqual([2, 3, 4])
  })

  test('a context line is numbered on both sides', () => {
    const context = lines.find((l) => l.type === 'context')
    expect(context?.oldLine).toBe(1)
    expect(context?.newLine).toBe(1)
  })

  test('the hunk header starts the count where git says', () => {
    // Not at 1. A hunk late in a file begins wherever its header says, and
    // numbering from zero is the failure that still renders.
    const later = parsePatch('@@ -40,3 +120,3 @@\n keep\n-gone\n+new\n')
    expect(later.find((l) => l.type === 'context')?.oldLine).toBe(40)
    expect(later.find((l) => l.type === 'context')?.newLine).toBe(120)
    expect(later.find((l) => l.type === 'added')?.newLine).toBe(121)
  })

  test('ids are unique, because they are react keys', () => {
    const ids = lines.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('the trailing newline is not a context line', () => {
    expect(lines.at(-1)?.content).not.toBe('')
  })

  test('a removed line that looks like a header is kept', () => {
    // `-- ` at the start of a source line is written `--- ` in a patch, and
    // dropping it as a file header deletes somebody's code and shifts every
    // number after it.
    const tricky = parsePatch(
      '@@ -1,3 +1,3 @@\n keep\n--- a line that begins with two dashes\n+++ a line that begins with two pluses\n',
    )
    expect(tricky.filter((l) => l.type === 'removed')).toHaveLength(1)
    expect(tricky.filter((l) => l.type === 'added')).toHaveLength(1)
    expect(tricky.find((l) => l.type === 'removed')?.content).toBe(
      '-- a line that begins with two dashes',
    )
  })

  test('the real file header is still dropped before the first hunk', () => {
    const content = parsePatch(PATCH)
      .map((l) => l.content)
      .join('\n')
    expect(content).not.toContain('--- a/src')
    expect(content).not.toContain('+++ b/src')
  })

  test('a binary diff numbers nothing and keeps its text whole', () => {
    const binary = parsePatch(
      'diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n',
    )
    expect(binary.every((l) => l.type === 'meta')).toBe(true)
    expect(binary.at(-1)?.content).toBe(
      'Binary files a/logo.png and b/logo.png differ',
    )
  })

  test('no newline at end of file numbers nothing', () => {
    const marked = parsePatch(
      '@@ -1,1 +1,1 @@\n-a\n+b\n\\ No newline at end of file\n',
    )
    expect(marked.at(-1)?.type).toBe('meta')
    expect(marked.at(-1)?.newLine).toBeUndefined()
  })
})

describe('languageOf', () => {
  test('maps the extensions the bundle carries', () => {
    expect(languageOf('src/a.ts')).toBe('typescript')
    expect(languageOf('src/a.tsx')).toBe('tsx')
    expect(languageOf('src-tauri/main.rs')).toBe('rust')
    expect(languageOf('Cargo.toml')).toBe('toml')
  })

  test('an unknown extension is plain text, not a missing grammar', () => {
    expect(languageOf('LICENSE')).toBe('text')
    expect(languageOf('a.xyz')).toBe('text')
  })
})
