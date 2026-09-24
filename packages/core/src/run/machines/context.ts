import type { IssueWorkContext, IssueWorkInput } from './types'

/**
 * The context a fresh run starts with.
 *
 * Optional fields are spread rather than set to undefined, because the context
 * is persisted as JSON on every transition and an explicit undefined and an
 * absent key are the same thing once it comes back.
 */
export function initialContext(input: IssueWorkInput): IssueWorkContext {
  return {
    runId: input.runId,
    repo: input.repo,
    issueNumber: input.issueNumber,
    maxRevisions: input.maxRevisions,
    revision: 0,
    planGeneration: 0,
    implementerReport: '',
    premiseBody: input.premiseBody,
    ...(input.planGated === undefined ? {} : { planGated: input.planGated }),
    ...(input.gatePollMs === undefined ? {} : { gatePollMs: input.gatePollMs }),
    ...(input.premiseIntervalMs === undefined
      ? {}
      : { premiseIntervalMs: input.premiseIntervalMs }),
  }
}
