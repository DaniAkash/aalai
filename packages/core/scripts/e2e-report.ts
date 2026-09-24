/**
 * How the end to end scripts say what happened.
 *
 * Shared so the two suites report identically: a scenario is a heading, a
 * check is a line, and the exit code is the number of failures. Nothing here
 * knows what is being tested.
 */

const ESCAPE = String.fromCharCode(27)
const COLOUR = new RegExp(`${ESCAPE}\\[[0-9;]*m`, 'g')

let failures = 0

export function scenario(name: string): void {
  process.stdout.write(`\n${name}\n`)
}

export function check(name: string, passed: boolean): void {
  process.stdout.write(`${passed ? '  PASS  ' : '  FAIL  '}${name}\n`)
  if (!passed) {
    failures += 1
  }
}

/** Terminal colour is noise when the output is being matched against. */
export function plain(text: string): string {
  return text.replace(COLOUR, '')
}

export function finish(): never {
  process.stdout.write(
    `\n${failures === 0 ? 'all scenarios passed' : `${failures} checks failed`}\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}
