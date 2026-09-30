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
  // Only when it will actually close. A duplicate that still needs something
  // from the reporter posts the question and leaves the issue open, and a
  // button promising to close it would be describing a different decision from
  // the one the line above it describes.
  if (facts.classification === 'duplicate' && facts.willClose) {
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

export interface WatchedPullRequest {
  readonly repo: string
  readonly number: number
  readonly state: string
  readonly ciFixes: number
  readonly revisions: number
}

/**
 * What a pull request being kept alive is doing, in one line.
 *
 * Deliberately not phrased as a question. Nothing is being asked of anybody
 * while this is running, and a row in the inbox that reads like a request is a
 * row somebody tries to answer and cannot. It says what is happening so the
 * absence of a decision is obvious.
 */
export function watchingLine(pr: WatchedPullRequest): string {
  switch (pr.state) {
    case 'fixing':
      return pr.ciFixes > 1
        ? `fixing the checks, attempt ${pr.ciFixes}`
        : 'fixing the checks'
    case 'classifyingFailure':
      return 'working out why the checks failed'
    case 'collecting':
      return 'gathering what came in'
    case 'saying':
      return 'saying the failure was not ours'
    default:
      return 'watching for checks and comments'
  }
}

/**
 * Why a watch stopped, for somebody reading a pull request that has gone quiet.
 *
 * The work is on the branch either way, so what matters is whether anybody is
 * expected to do something and what was already tried.
 */
export function stoppedBecause(outcome: {
  kind: string
  why?: string
  author?: string
  state?: string
}): string {
  switch (outcome.kind) {
    case 'handedBack':
      return `${outcome.author ?? 'somebody'} pushed to the branch, so this stopped touching it`
    case 'exhausted':
      return outcome.why ?? 'there was nothing left to try'
    case 'closed':
      // Not "green". A pull request can be closed with its checks red, and
      // saying otherwise describes the opposite of what happened.
      return outcome.state === 'MERGED'
        ? 'it was merged'
        : 'it was closed without being merged'
    case 'settled':
      return 'the checks are green and nobody is asking for anything'
    case 'stale':
      return 'nobody came back to it'
    default:
      return 'it stopped for a reason it did not record'
  }
}

export interface TrustFacts {
  /** Why this is being asked rather than assumed, from Q2. */
  readonly because: string
  /** Who wrote the code, as far as GitHub can tell. */
  readonly authors: readonly string[]
  readonly repo: string
  readonly prNumber: number
}

/**
 * What approving a trust gate actually does, before it is approved.
 *
 * The most consequential sentence in the product. Everything else a gate has
 * ever asked could be undone: a comment can be deleted, a branch can be thrown
 * away, a pull request can be closed. This one runs somebody else's code on the
 * machine reading it, and nothing undoes that.
 *
 * So it says the thing rather than the category. "Approve" is what the button
 * would say if this were a plan.
 */
export function trustConsequence(facts: TrustFacts): string {
  return `Runs this branch's tests on your machine, as code written by ${facts.authors.join(' and ')}.`
}

/** What the button says, which is never the word approve. */
export function trustLabel(): string {
  return 'Run it'
}

/** Why it is being asked at all, in the words Q2 used. */
export function trustReason(facts: TrustFacts): string {
  return `This is being asked because there is ${facts.because}.`
}
