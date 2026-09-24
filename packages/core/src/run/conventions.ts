import { join } from 'node:path'
import { Glob } from 'bun'

/**
 * Convention files an agent should read before changing a repository, in the
 * order they are looked for.
 *
 * Codex loads `AGENTS.md` from its working directory on its own; the others it
 * does not. Rather than copying or symlinking anything into the worktree, where
 * it could be committed by accident, detected files are named in the prompt and
 * the agent reads them with its own tools. Naming the path beats inlining the
 * contents: no token bloat, and no drift between a stale copy and the real file.
 */
const CONVENTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  '.cursorrules',
] as const

const RULE_GLOBS = ['.cursor/rules/*.mdc', '.github/instructions/*.md'] as const

export async function detectConventions(root: string): Promise<string[]> {
  const found: string[] = []
  for (const candidate of CONVENTION_FILES) {
    if (await Bun.file(join(root, candidate)).exists()) {
      found.push(candidate)
    }
  }
  for (const pattern of RULE_GLOBS) {
    const glob = new Glob(pattern)
    for await (const match of glob.scan({
      cwd: root,
      dot: true,
      onlyFiles: true,
    })) {
      found.push(match)
    }
  }
  return found
}

/** The standing instruction appended to the agent's system prompt. */
export function conventionsInstruction(files: readonly string[]): string {
  if (files.length === 0) {
    return [
      'This repository documents no agent conventions file.',
      'Infer its conventions from the surrounding code before making changes: match the existing style, naming, error handling, and test layout.',
    ].join(' ')
  }
  return [
    `This repository documents its conventions in: ${files.join(', ')}.`,
    'Read every one of those files before making any change, and follow them exactly.',
    'They outrank your own defaults wherever the two disagree.',
  ].join(' ')
}
