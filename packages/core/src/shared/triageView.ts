/**
 * How a triage report reads to a person, shared by the terminal and the
 * interface so they cannot describe the same decision differently.
 *
 * Lives beside the other formatting with no runtime behind it, which is what
 * makes it safe in a browser bundle.
 */

/**
 * What a classifier may decide, and how sure it may be.
 *
 * Here rather than beside the schema because the interface offers these as
 * buttons and the schema validates them, and a list that exists twice is a
 * list that will disagree with itself. The schema builds its enum from this.
 */
export const CLASSIFICATIONS = [
  'bug',
  'feature',
  'question',
  'duplicate',
  'security',
  'noise',
] as const

export const CONFIDENCES = ['low', 'medium', 'high'] as const

export type Classification = (typeof CLASSIFICATIONS)[number]
export type Confidence = (typeof CONFIDENCES)[number]

export interface TriageFacts {
  readonly classification: string
  readonly confidence: string
  readonly duplicateOf?: number | undefined
  readonly willComment: boolean
  readonly willClose: boolean
}

/**
 * What clicking approve actually does, in one line, before it is clicked.
 *
 * The most important sentence in the triage surface. Approving can post a
 * comment under the maintainer's name on a public repository, and the
 * difference between that and starting a run is not visible from the word
 * "approve". Nothing else here matters as much as this being accurate.
 */
export function approvalConsequence(facts: TriageFacts): string {
  if (facts.classification === 'security') {
    return 'Nothing will be posted. This is a security report.'
  }
  if (facts.classification === 'bug' || facts.classification === 'feature') {
    return 'Starts a run. Nothing is posted yet.'
  }
  if (facts.willComment && facts.willClose) {
    return 'Posts a comment and closes the issue.'
  }
  if (facts.willClose) {
    return 'Closes the issue. Nothing is posted.'
  }
  if (facts.willComment) {
    return 'Posts a comment on the issue.'
  }
  return 'Records the decision. Nothing is posted.'
}

/**
 * Whether this should be put to a person as a proposal or as a question.
 *
 * Being wrong about a duplicate is expensive and rude, so a low confidence one
 * is asked rather than proposed. That is a rendering decision driven by a value
 * the classifier had to commit to.
 */
export function readsAsQuestion(facts: TriageFacts): boolean {
  return facts.confidence === 'low'
}

/** What the primary button should say, which is not always "approve". */
export function approvalLabel(facts: TriageFacts): string {
  if (facts.classification === 'bug' || facts.classification === 'feature') {
    return 'Approve and start'
  }
  if (facts.classification === 'duplicate') {
    return readsAsQuestion(facts) ? 'Close as duplicate' : 'Approve'
  }
  return 'Approve'
}

/** The classification as a person reads it, hedged when the classifier hedged. */
export function classificationLine(facts: TriageFacts): string {
  const named =
    facts.duplicateOf === undefined
      ? facts.classification
      : `duplicate of #${facts.duplicateOf}`
  return readsAsQuestion(facts) ? `possibly ${named}?` : named
}

/**
 * Reads the facts a decision needs back out of the report.
 *
 * The report is markdown with frontmatter, because an artifact is what a person
 * reads and the database stores its path rather than its content. The three
 * values the buttons depend on are parsed back out here rather than being
 * carried separately, so there is one copy of them and it is the one on disk.
 */
export function factsFromReport(
  report: string | null,
): TriageFacts | undefined {
  // No report, or one with no classification in it, is not a bug: it is a
  // screen that cannot say what approving would do. Defaulting here offered
  // "Approve and start" over an artifact nobody had read, which is authority
  // granted on facts that were never shown.
  const classification = field(report, 'classification')
  if (classification === undefined) {
    return undefined
  }
  // The report writes it as "**Duplicates:** #12"; the schema calls it
  // `duplicate_of`. Both spellings are looked for rather than one being made
  // to match the other, because the report is what a person reads.
  const duplicate = Number(
    field(report, 'duplicate_of') ?? field(report, 'duplicates') ?? '',
  )
  return {
    classification,
    confidence: field(report, 'confidence') ?? 'medium',
    duplicateOf:
      Number.isFinite(duplicate) && duplicate > 0 ? duplicate : undefined,
    // A reply was drafted, so approving says it. Read from the report for the
    // same reason as the rest: the artifact is the record.
    willComment:
      classification !== 'security' &&
      (report ?? '').includes('## Drafted reply'),
    // Nothing still waiting on an answer is closed, which is the rule delivery
    // applies. Reading it off the report keeps the sentence above the button
    // true: a report that asks the reporter for detail posts the question and
    // leaves the issue open, and saying otherwise would promise a close that
    // never comes.
    willClose:
      !asksForMore(report) &&
      (classification === 'duplicate' ||
        classification === 'noise' ||
        classification === 'question'),
  }
}

/** Whether the report says something it needs is missing. */
function asksForMore(report: string | null): boolean {
  const section = /^## Missing\s*$([\s\S]*?)(?=^## |Z)/m.exec(report ?? '')
  const body = (section?.[1] ?? '').trim()
  return body !== '' && !/^_?\s*nothing\.?\s*_?$/i.test(body)
}

/** A frontmatter value, or a bold field in the body, whichever the report used. */
function field(report: string | null, name: string): string | undefined {
  if (report === null) {
    return undefined
  }
  const front = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(report)
  if (front?.[1] !== undefined) {
    return front[1].trim()
  }
  const label = name.replace(/_/g, ' ')
  const bold = new RegExp(`\\*\\*${label}:\\*\\*\\s*#?(.+)`, 'i').exec(report)
  return bold?.[1]?.trim()
}
