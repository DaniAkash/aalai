import type { Config, WatchedRepo } from '@/config'
import type { RunPolicy } from '@/modules/settings/domains'

/**
 * The policy one watched repository runs under.
 *
 * A repository's own setting overrides the global default, the same way its
 * label gate does, so a toy repository and the day job do not have to agree.
 */
function policyFor(config: Config, watched?: WatchedRepo): RunPolicy {
  return watched?.policy ?? config.defaultPolicy
}

export function policyForRepo(config: Config, repo: string): RunPolicy {
  return policyFor(
    config,
    config.watch.find((watched) => watched.repo === repo),
  )
}

/** Whether the plan needs a person before any code is written. */
export function planIsGated(policy: RunPolicy): boolean {
  return policy === 'plan_gate'
}
