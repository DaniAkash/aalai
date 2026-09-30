import { join } from 'node:path'

/**
 * How a repository runs its own tests, read from the repository.
 *
 * Read rather than assumed, and refused rather than guessed. Inventing a command
 * and running it in somebody's checkout is a worse failure than saying the tests
 * could not be found: the guess might be a deploy script.
 */
export interface TestCommand {
  readonly argv: readonly string[]
  readonly how: string
}

export type TestDiscovery =
  | { readonly found: true; readonly command: TestCommand }
  | { readonly found: false; readonly why: string }

/** The test script a package declares, or nothing. */
export async function findTestCommand(root: string): Promise<TestDiscovery> {
  const manifest = join(root, 'package.json')
  let parsed: { scripts?: Record<string, string> }
  try {
    parsed = (await Bun.file(manifest).json()) as {
      scripts?: Record<string, string>
    }
  } catch {
    return {
      found: false,
      why: 'there is no package.json, so how this repository runs its tests is not something to guess at',
    }
  }
  const script = parsed.scripts?.test
  if (script === undefined || script.trim() === '') {
    return {
      found: false,
      why: 'this repository declares no test script',
    }
  }
  // The package manager runs whatever the repository declared. Parsing the
  // script itself and running the parts would be reinventing that badly, and
  // getting it wrong means running something nobody asked for.
  return {
    found: true,
    command: { argv: ['bun', 'run', 'test'], how: script },
  }
}
