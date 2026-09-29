import type { Config } from '@/config'
import {
  buildCiFixPrompt,
  buildFaultPrompt,
  buildStationRules,
} from '@/prompts/stations'
import { runStation, type StationResult } from '@/run/station'
import { type FaultVerdict, faultSchema } from '@/run/stations/schemas'
import { structuredStation } from '@/run/stations/structured'

export interface FaultInput {
  readonly runId: string
  readonly repo: string
  readonly prNumber: number
  readonly failing: readonly string[]
  readonly log: string
  readonly diff: string
  readonly worktree: string
  readonly config: Config
  readonly signal?: AbortSignal
}

/** Decides whether a failing check is this change's fault. Modifies nothing. */
export async function runFaultClassifier(
  input: FaultInput,
): Promise<{ verdict: FaultVerdict; result: StationResult }> {
  const { value, result } = await structuredStation(
    'classifier',
    {
      agent: input.config.agents.reviewer,
      runId: input.runId,
      station: 'classifier',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      subject: { repo: input.repo, kind: 'pr', number: input.prNumber },
      title: `why #${input.prNumber} is failing`,
      label: 'fault',
      worktree: input.worktree,
      systemRules: buildStationRules('classifier'),
      task: buildFaultPrompt({
        repo: input.repo,
        prNumber: input.prNumber,
        failing: input.failing,
        log: input.log,
        diff: input.diff,
      }),
      // Reads only. Deciding whose fault something is is not work.
      permission: 'approve-reads',
      config: input.config,
    },
    faultSchema,
    // No write tool for this one: a verdict is a sentence rather than an
    // artifact, and nothing later reads it off disk.
    () => undefined,
  )
  return { verdict: value, result }
}

export interface CiFixInput {
  readonly runId: string
  readonly repo: string
  readonly prNumber: number
  readonly failing: readonly string[]
  readonly log: string
  readonly why: string
  readonly attempt: number
  readonly worktree: string
  readonly config: Config
  readonly signal?: AbortSignal
}

/** Re-enters the implementer with a failure that did not exist when the run started. */
export async function runCiFixer(input: CiFixInput): Promise<StationResult> {
  return runStation({
    agent: input.config.agents.implementer,
    runId: input.runId,
    station: 'implementer',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    subject: { repo: input.repo, kind: 'pr', number: input.prNumber },
    title: `fixing the checks on #${input.prNumber}`,
    label: 'ci-fix',
    worktree: input.worktree,
    systemRules: buildStationRules('implementer'),
    task: buildCiFixPrompt({
      repo: input.repo,
      prNumber: input.prNumber,
      failing: input.failing,
      log: input.log,
      why: input.why,
      attempt: input.attempt,
    }),
    permission: 'approve-all',
    config: input.config,
  })
}
