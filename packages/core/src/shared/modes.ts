/**
 * What a run may be told to do, and the four ways a person asks for it.
 *
 * The list lives here rather than in the settings domains because the app
 * reads it as a value, and anything the app imports as a value has to resolve
 * from the shared entry point alone. Settings imports it from here.
 */
export const RUN_POLICIES = [
  'automatic',
  'plan_gate',
  'talk',
  'triage',
] as const

export type RunPolicy = (typeof RUN_POLICIES)[number]

/**
 * The four ways to start a piece of work, as a person chooses between them.
 *
 * The wording lives here rather than in the app because it is the contract,
 * not decoration: each line is a promise about what the stations will and will
 * not do. Keeping it beside the policy it names is what stops the menu
 * describing behaviour the run does not have.
 */

export interface WorkMode {
  readonly policy: RunPolicy
  readonly label: string
  readonly description: string
}

export const WORK_MODES: readonly WorkMode[] = [
  {
    policy: 'plan_gate',
    label: 'Plan first',
    description: 'Read the repository, write a plan, wait for you to agree',
  },
  {
    policy: 'talk',
    label: 'Talk it through',
    description: 'Ask questions until the goal is clear, then plan',
  },
  {
    policy: 'triage',
    label: 'Triage only',
    description: 'Say what is wrong and what it would take. Change nothing',
  },
  {
    policy: 'automatic',
    label: 'Start now',
    description: 'Skip the plan and go straight to a draft pull request',
  },
]

/** The mode a composer opens on: the one that asks before it writes code. */
export const DEFAULT_MODE: RunPolicy = 'plan_gate'

export function modeNamed(policy: string): WorkMode | undefined {
  return WORK_MODES.find((mode) => mode.policy === policy)
}
