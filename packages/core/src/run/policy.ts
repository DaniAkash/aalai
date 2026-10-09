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

/**
 * The policy one run goes by.
 *
 * A mode chosen in the composer is about one piece of work and outranks the
 * repository's standing answer, which is what a run the watcher started still
 * uses. Null rather than a default on the column, so "no answer" and "the same
 * answer as the repository" stay the same thing after the repository's changes.
 */
export function policyForRun(
  config: Config,
  repo: string,
  chosen: RunPolicy | null | undefined,
): RunPolicy {
  return chosen ?? policyForRepo(config, repo)
}

/**
 * Whether the plan needs a person before any code is written.
 *
 * True for `talk` as well. The difference between the two is what the analyst
 * writes first, not whether somebody has to agree to it: talking it through is
 * the same gate reached with questions rather than with an answer.
 */
export function planIsGated(policy: RunPolicy): boolean {
  return policy === 'plan_gate' || policy === 'talk'
}

/**
 * Whether the analyst should lead with what it does not know.
 *
 * The revision loop already carries this: a plan, a person asking for changes,
 * the next version. This is that loop entered deliberately, so the first thing
 * recorded is the questions rather than a guess at the answers.
 */
export function asksFirst(policy: RunPolicy): boolean {
  return policy === 'talk'
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
export function keepsPullRequestsAlive(config: Config, repo: string): boolean {
  const watched = config.watch.find((w) => w.repo === repo)
  return watched?.keepPullRequestsAlive ?? config.keepPullRequestsAlive
}
