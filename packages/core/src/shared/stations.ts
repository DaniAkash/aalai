/**
 * The four stations, and what each one is for.
 *
 * The sentences are the contract a person reads before changing anything: what
 * the station does, and what it cannot do however it is configured. They live
 * beside the names rather than in the screen because they describe the run,
 * not the page.
 */

export const STATION_NAMES = [
  'classifier',
  'analyst',
  'implementer',
  'reviewer',
] as const

export type StationName = (typeof STATION_NAMES)[number]

export interface StationBlurb {
  readonly name: StationName
  readonly title: string
  readonly sentence: string
  /** Whether a person may choose which agent drives it. */
  readonly configurableAgent: boolean
}

export const STATION_BLURBS: readonly StationBlurb[] = [
  {
    name: 'classifier',
    title: 'Triage',
    sentence:
      'Decides what an issue actually is before anyone acts on it. Writes nothing to the repository.',
    configurableAgent: false,
  },
  {
    name: 'analyst',
    title: 'Analyst',
    sentence:
      'Reads the repository and writes the plan. Cannot write a file or push a branch.',
    configurableAgent: true,
  },
  {
    name: 'implementer',
    title: 'Implementer',
    sentence:
      'Writes the change against the plan version you approved and opens a draft pull request.',
    configurableAgent: true,
  },
  {
    name: 'reviewer',
    title: 'Reviewer',
    sentence:
      'Answers review comments on the pull request and pushes the follow up commit. Never merges.',
    configurableAgent: true,
  },
]

export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
