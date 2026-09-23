import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { conventionsInstruction, detectConventions } from '@/run/conventions'

async function repoWith(files: Record<string, string>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'aalai-conv-'))
  for (const [path, contents] of Object.entries(files)) {
    await Bun.write(join(root, path), contents)
  }
  return root
}

describe('detectConventions', () => {
  test('finds AGENTS.md', async () => {
    const root = await repoWith({ 'AGENTS.md': '# rules' })
    expect(await detectConventions(root)).toEqual(['AGENTS.md'])
  })

  test('finds CLAUDE.md, which codex does not load on its own', async () => {
    const root = await repoWith({ 'CLAUDE.md': '# rules' })
    expect(await detectConventions(root)).toEqual(['CLAUDE.md'])
  })

  test('finds several, in a stable order', async () => {
    const root = await repoWith({
      'AGENTS.md': 'a',
      'CLAUDE.md': 'c',
      '.github/copilot-instructions.md': 'g',
    })
    expect(await detectConventions(root)).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      '.github/copilot-instructions.md',
    ])
  })

  test('finds globbed rule files', async () => {
    const root = await repoWith({ '.cursor/rules/style.mdc': 'x' })
    expect(await detectConventions(root)).toContain('.cursor/rules/style.mdc')
  })

  test('returns nothing for a repo with no conventions', async () => {
    const root = await repoWith({ 'README.md': 'hi' })
    expect(await detectConventions(root)).toEqual([])
  })
})

describe('conventionsInstruction', () => {
  test('names every detected file and tells the agent they win', () => {
    const text = conventionsInstruction(['AGENTS.md', 'CLAUDE.md'])
    expect(text).toContain('AGENTS.md, CLAUDE.md')
    expect(text).toContain('outrank')
  })

  test('says so explicitly when there are none', () => {
    expect(conventionsInstruction([])).toContain('no agent conventions file')
  })
})
