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

/**
 * Whether an issue is classified before anyone considers acting on it.
 *
 * The value has existed since the gate work and was read by nothing, so a
 * repository set to `triage` behaved exactly like one set to `automatic`. This
 * is what gives it meaning.
 */
export function triageFirst(policy: RunPolicy): boolean {
  return policy === 'triage'
}

/**
 * Whether this repository's pull requests are kept alive after delivery.
 *
 * A repository's own answer overrides the global one, the same way its label
 * gate and its run policy do. The question is how closely somebody is watching
 * the repository rather than what they prefer in general: a repository nobody
 * looks at daily is one where background revisions accumulate unseen.
 */
// TEMPORARY: read by the delivery hand off, which lands in a later commit.
// fallow-ignore-next-line unused-export
export function keepsPullRequestsAlive(config: Config, repo: string): boolean {
  const watched = config.watch.find((w) => w.repo === repo)
  return watched?.keepPullRequestsAlive ?? config.keepPullRequestsAlive
}
