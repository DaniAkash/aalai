import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'bun:test'
import { changedFiles, partitionStagePaths, stageAll } from '@/lib/git'
import { execOrThrow } from '@/lib/proc'

/**
 * Exercises staging against a real repository rather than a mock, because the
 * behaviour under test is git's pathspec handling, which a fake cannot reproduce.
 */
let repo: string

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'aalai-stage-'))
  await execOrThrow(['git', 'init', '-q', '-b', 'main'], { cwd: repo })
  // Neutralise the machine's global excludes file. Without this the test passes
  // on a machine that already ignores node_modules globally, which is precisely
  // the condition the guard is not supposed to depend on.
  await execOrThrow(['git', 'config', 'core.excludesFile', '/dev/null'], { cwd: repo })
  await Bun.write(join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  // No .gitignore on purpose: this is the repository shape the guard exists for.
  await Bun.write(join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  await Bun.write(join(repo, 'dist', 'bundle.js'), 'console.log(1)\n')
})

describe('stageAll', () => {
  test('stages source but not dependency or build output', async () => {
    await stageAll(repo)
    const staged = await execOrThrow(['git', 'diff', '--cached', '--name-only'], { cwd: repo })
    const paths = staged.split('\n').filter((line) => line !== '')

    expect(paths).toContain('src/a.ts')
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false)
    expect(paths.some((p) => p.startsWith('dist/'))).toBe(false)
  })
})

describe('changedFiles', () => {
  test('reports real paths with no status prefix, so the partition can read them', async () => {
    const changed = await changedFiles(repo)
    expect(changed).toContain('src/a.ts')
    for (const path of changed) {
      expect(path.startsWith(' ')).toBe(false)
      expect(path).not.toMatch(/^[ MARCDU?!]{2} /)
    }
    const { generated } = partitionStagePaths(changed)
    expect(generated.length).toBeGreaterThan(0)
  })
})
