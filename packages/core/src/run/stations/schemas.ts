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
 * A list an agent may reasonably hand back grouped rather than flat.
 *
 * A station asked for the surface a change touches will sometimes answer with
 * `{ implementation: [...], public_interface: [...] }`, which is a better
 * answer than a flat list and was being rejected for it. Grouping is flattened
 * in declaration order, a bare string becomes a single entry, and everything
 * else still fails.
 *
 * Be strict about shape that carries meaning and forgiving about how an agent
 * chose to organise it. The alternative costs a second expensive turn and, on
 * a retry that answers the same way, the whole run.
 */
const looseList = z
  .union([
    z.string(),
    z.array(z.string()),
    z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  ])
  .transform((value): string[] => {
    const entries =
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value
          : Object.values(value).flatMap((entry) =>
              Array.isArray(entry) ? entry : [entry],
            )
    // Blank entries are dropped, so an empty string cannot pass a minimum-length
    // check as one criterion that says nothing.
    return entries.map((entry) => entry.trim()).filter((entry) => entry !== '')
  })

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
  plan: looseList.pipe(z.array(z.string()).min(1)),
  affected_surface: looseList,
  risks: looseList,
  acceptance_criteria: looseList.pipe(z.array(z.string()).min(1)),
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
  // At least one, so a station cannot approve with no evidence at all. The
  // gate checks coverage against the analyst's criteria; this only refuses the
  // degenerate case that would otherwise parse cleanly.
  criteria_results: z.array(criterionResultSchema).min(1),
  blocking_findings: looseList,
  summary: looseText,
})

export type Review = z.infer<typeof reviewSchema>
export type CriterionResult = z.infer<typeof criterionResultSchema>
