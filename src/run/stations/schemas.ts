import { z } from 'zod'

/**
 * Prose that an agent may reasonably return as either a paragraph or a list.
 *
 * Be strict about shape that carries meaning (acceptance criteria must be a
 * list, a verdict must be one of three words) and forgiving about how prose is
 * formatted. A run should not fail, and a second expensive turn should not be
 * spent, because a station enumerated its test strategy instead of writing it
 * out.
 */
const looseText = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value.join('\n') : value))
  .pipe(z.string().min(1))

/**
 * The analyst's output, and the contract the reviewer is later handed.
 *
 * `acceptance_criteria` is the field that matters: it is written before any
 * code exists and passed to the reviewer verbatim, so the station that writes
 * the code never gets to define what done means for its own work.
 */
export const analysisSchema = z.object({
  problem_statement: looseText,
  approach: looseText,
  plan: z.array(z.string()).min(1),
  affected_surface: z.array(z.string()),
  risks: z.array(z.string()),
  acceptance_criteria: z.array(z.string()).min(1),
  test_strategy: looseText,
})

export type Analysis = z.infer<typeof analysisSchema>

/** One acceptance criterion, judged on its own, with a pointer into the diff. */
export const criterionResultSchema = z.object({
  criterion: z.string().min(1),
  pass: z.boolean(),
  evidence: looseText,
})

/**
 * The reviewer's verdict.
 *
 * Per-criterion results rather than a single boolean, because a verdict without
 * evidence is an opinion, and the pull request body is meant to be auditable in
 * thirty seconds.
 */
export const reviewSchema = z.object({
  verdict: z.enum(['approve', 'request_changes', 'reject']),
  criteria_results: z.array(criterionResultSchema),
  blocking_findings: z.array(z.string()),
  summary: looseText,
})

export type Review = z.infer<typeof reviewSchema>
export type CriterionResult = z.infer<typeof criterionResultSchema>
