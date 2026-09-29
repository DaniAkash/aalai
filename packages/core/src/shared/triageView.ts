/**
 * How a triage report reads to a person, shared by the terminal and the
 * interface so they cannot describe the same decision differently.
 *
 * Lives beside the other formatting with no runtime behind it, which is what
 * makes it safe in a browser bundle.
 */

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
