import type { Database } from 'bun:sqlite'
import type { Config } from '@/config'
import type { GhIssue } from '@/lib/gh'
import type { RunRef } from '@/modules/work/paths'
import type { Workspace } from '@/run/workspace'

/**
 * The things a run needs that cannot be written into a snapshot.
 *
 * A persisted snapshot is JSON, so a database handle and a worktree do not
 * belong in machine context. Context carries what describes the run and this
 * carries what performs it, looked up by run id when an actor starts. That is
 * also what keeps a restored snapshot honest: it describes a run rather than
 * holding a live connection that no longer exists.
 */
export interface RunDeps {
  readonly db: Database
  readonly config: Config
  readonly issue: GhIssue
  readonly repo: string
  readonly workspace: Workspace
  readonly run: RunRef
  readonly conventionFiles: readonly string[]
}

const registry = new Map<string, RunDeps>()

export function provideRunDeps(runId: string, deps: RunDeps): void {
  registry.set(runId, deps)
}

export function runDeps(runId: string): RunDeps {
  const deps = registry.get(runId)
  if (deps === undefined) {
    throw new Error(`no dependencies registered for run ${runId}`)
  }
  return deps
}

export function releaseRunDeps(runId: string): void {
  registry.delete(runId)
}
