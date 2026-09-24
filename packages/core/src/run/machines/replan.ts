import type { IssueWorkContext } from './types'

/**
 * Starting over on a new plan rather than revising the old one.
 *
 * Two things reach this: the issue being rewritten under a run, and a person
 * asking for changes at the plan gate. They are the same event from the
 * machine's point of view, because in both cases the request the work was
 * planned against is no longer the request.
 *
 * The generation moves so the analyst runs a fresh attempt instead of returning
 * the plan it already recorded. The revision count resets because the passes
 * already spent were spent on something else, and a verdict about the old plan
 * is not guidance about the new one.
 */
export const startAFreshPlan = {
  planGeneration: ({ context }: { context: IssueWorkContext }) =>
    context.planGeneration + 1,
  revision: () => 0,
  review: () => undefined,
  implementerReport: () => '',
}
