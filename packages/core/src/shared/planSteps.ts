/**
 * The steps out of a recorded plan.
 *
 * A plan is stored as the markdown a person reads, which is the right store:
 * one document, versioned, that an agent and a person see the same way. The
 * interface needs the steps as a list, so the list is derived here rather than
 * kept as a second copy that can disagree with the document.
 *
 * Scanned rather than matched. Every pattern that reads "whitespace, then the
 * rest of the line" has two parts that both accept a space, which is the shape
 * that backtracks: an earlier version was quadratic on a padded line, 1673ms
 * on sixty thousand spaces. A plan is markdown an agent wrote, so its length
 * and shape are not ours to assume. These are single forward passes, so the
 * cost is the length of the line and nothing else.
 */

const SPACE = 32
const TAB = 9
const ZERO = 48
const NINE = 57

function isBlank(code: number): boolean {
  return code === SPACE || code === TAB
}

function isDigit(code: number): boolean {
  return code >= ZERO && code <= NINE
}

/** The text of a level two heading, or nothing if the line is not one. */
function headingTitle(line: string): string | undefined {
  if (!line.startsWith('##')) {
    return undefined
  }
  // A third hash is a deeper heading, not this one, and is not a space.
  const rest = line.slice(2)
  return rest !== '' && isBlank(rest.charCodeAt(0)) ? rest.trim() : undefined
}

/** The text of a numbered list item, or nothing if the line is not one. */
function numberedBody(line: string): string | undefined {
  let at = 0
  while (at < line.length && isBlank(line.charCodeAt(at))) {
    at += 1
  }
  const firstDigit = at
  while (at < line.length && isDigit(line.charCodeAt(at))) {
    at += 1
  }
  if (at === firstDigit) {
    return undefined
  }
  const punctuation = line.charAt(at)
  if (punctuation !== '.' && punctuation !== ')') {
    return undefined
  }
  const rest = line.slice(at + 1)
  return rest !== '' && isBlank(rest.charCodeAt(0)) ? rest.trim() : undefined
}

/**
 * Reads the numbered list under a heading.
 *
 * Scoped to one section because a plan has several numbered lists, and the
 * acceptance criteria are not steps. The ordinals in the document are ignored:
 * the position in the list is what a step index means, and a plan that skips
 * from 2 to 4 should still have three steps rather than a hole.
 */
export function planSteps(body: string, section = 'Steps'): string[] {
  const steps: string[] = []
  const wanted = section.toLowerCase()
  let inside = false

  for (const line of body.split('\n')) {
    const heading = headingTitle(line)
    if (heading !== undefined) {
      inside = heading.toLowerCase() === wanted
      continue
    }
    if (!inside) {
      continue
    }
    const step = numberedBody(line)
    // A step of nothing but spaces would render as a blank row that reads as
    // a layout fault rather than as an empty step.
    if (step !== undefined && step !== '') {
      steps.push(step)
    }
  }
  return steps
}
