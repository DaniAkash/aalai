import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findTestCommand } from '@/run/testCommand'

/**
 * Finding out how a repository runs its tests.
 *
 * The rule is that it is read rather than guessed. Inventing a command and
 * running it in somebody else's checkout is worse than admitting the tests
 * could not be found, because the guess might be a deploy script.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-testcmd-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function manifest(contents: unknown) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(contents))
}

describe('when the repository says', () => {
  test('the declared script is used', async () => {
    manifest({ scripts: { test: 'bun test' } })
    const found = await findTestCommand(dir)
    expect(found.found).toBe(true)
    expect(found.found === true && found.command.how).toBe('bun test')
  })

  test('and it is run through the package manager rather than parsed', async () => {
    // Splitting the script and running the pieces would reinvent the package
    // manager badly, and getting it wrong runs something nobody asked for.
    manifest({ scripts: { test: 'vitest run --coverage && tsc --noEmit' } })
    const found = await findTestCommand(dir)
    expect(found.found === true && found.command.argv).toEqual([
      'bun',
      'run',
      'test',
    ])
  })
})

describe('when it does not say', () => {
  test('no test script is admitted rather than assumed', async () => {
    manifest({ scripts: { build: 'tsc' } })
    const found = await findTestCommand(dir)
    expect(found.found).toBe(false)
    expect(found.found === false && found.why).toContain('no test script')
  })

  test('an empty test script counts as none', async () => {
    manifest({ scripts: { test: '   ' } })
    expect((await findTestCommand(dir)).found).toBe(false)
  })

  test('no manifest at all is admitted too', async () => {
    const found = await findTestCommand(dir)
    expect(found.found).toBe(false)
    expect(found.found === false && found.why).toContain('no package.json')
  })

  test('and an unreadable manifest is not treated as an empty one', async () => {
    writeFileSync(join(dir, 'package.json'), '{ not json')
    const found = await findTestCommand(dir)
    expect(found.found).toBe(false)
  })
})
