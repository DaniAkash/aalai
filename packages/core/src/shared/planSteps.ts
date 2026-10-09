/**
 * The steps out of a recorded plan.
 *
 * A plan is stored as the markdown a person reads, which is the right store:
 * one document, versioned, that an agent and a person see the same way. The
 * interface needs the steps as a list, so the list is derived here rather than
 * kept as a second copy that can disagree with the document.
 *
 * Derived from text, so it is tested before anything draws from it. A step
 * list that is wrong by one shows the wrong row as running, which looks
 * entirely plausible.
 */

const HEADING = /^##\s+(?<title>.+?)\s*$/
const NUMBERED = /^\s*(?<ordinal>\d+)[.)]\s+(?<body>.+?)\s*$/

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
  let inside = false

  for (const line of body.split('\n')) {
    const heading = HEADING.exec(line)
    if (heading?.groups !== undefined) {
      inside = heading.groups.title?.toLowerCase() === section.toLowerCase()
      continue
    }
    if (!inside) {
      continue
    }
    const numbered = NUMBERED.exec(line)
    if (numbered?.groups?.body !== undefined) {
      steps.push(numbered.groups.body)
    }
  }
  return steps
}
