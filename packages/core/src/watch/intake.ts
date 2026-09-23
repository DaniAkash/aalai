import type { GhIssue } from '@/lib/gh'

/**
 * GitHub roles the repository has granted write-ish trust to. Anything outside
 * this set (CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE, MANNEQUIN) is an account
 * the repo has not trusted, so its issue body must not become agent instructions.
 */
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
])

export interface IntakePolicy {
  readonly trustedAuthorsOnly: boolean
  readonly requireLabel: string | null
}

export type Screening =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: string }

const ACCEPTED: Screening = { accepted: true }

/**
 * Decides whether one issue may start a run. Pure, so the whole intake policy is
 * testable against recorded API payloads without touching the network.
 */
export function screenIssue(issue: GhIssue, policy: IntakePolicy): Screening {
  // The REST issues endpoint returns pull requests as issues. Without this the
  // factory would try to implement its own pull requests.
  if (issue.pull_request !== undefined && issue.pull_request !== null) {
    return { accepted: false, reason: 'is a pull request' }
  }
  if (issue.state !== 'open') {
    return { accepted: false, reason: `state is ${issue.state}` }
  }
  if (policy.requireLabel !== null) {
    const labelled = issue.labels.some((label) => label.name === policy.requireLabel)
    if (!labelled) {
      return { accepted: false, reason: `missing label "${policy.requireLabel}"` }
    }
  }
  if (policy.trustedAuthorsOnly && !TRUSTED_ASSOCIATIONS.has(issue.author_association)) {
    return {
      accepted: false,
      reason: `author_association ${issue.author_association} is not trusted`,
    }
  }
  return ACCEPTED
}
