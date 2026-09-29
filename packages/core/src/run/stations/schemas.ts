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
const criterionResultSchema = z.object({
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

import { CLASSIFICATIONS, CONFIDENCES } from '@/shared/triageView'

/**
 * What the classifier decided about an issue, before any code is considered.
 *
 * `confidence` is a field rather than a sentence inside the reasoning because
 * the interface has to render it: being wrong about a duplicate is expensive
 * and rude, so a low confidence duplicate is presented as a question rather
 * than as a proposal, and that is a decision driven by this value.
 *
 * `duplicate_of` is only meaningful for a duplicate and is deliberately not
 * required for one: a classifier that suspects a duplicate without being able
 * to name it has said something useful, and forcing it to invent a number
 * would be worse than letting it say so.
 */
export const triageSchema = z.object({
  classification: z.enum(CLASSIFICATIONS),
  confidence: z.enum(CONFIDENCES),
  /** One line a person can read in the inbox without opening anything. */
  summary: looseText,
  reasoning: looseText,
  /** What a fix would touch, when it is actionable. Empty otherwise. */
  affected_surface: looseList,
  /** The issue this duplicates, when it is one. */
  duplicate_of: z.coerce.number().int().positive().optional(),
  /**
   * What aalai would say to the reporter, when it has something to say.
   *
   * Drafted here and posted by nobody: it becomes an intent that a person
   * releases, and the station never learns whether it went out.
   */
  reply: looseText.optional(),
  /** What is missing, when the issue cannot be acted on without more. */
  missing: looseList,
})

export type Triage = z.infer<typeof triageSchema>

/** Whether this classification means a person is being asked to allow a run. */
export function isActionable(triage: Triage): boolean {
  return triage.classification === 'bug' || triage.classification === 'feature'
}

/**
 * Whether anything at all may be said in public about this.
 *
 * A security report is the one class where the ordinary courtesy is the leak:
 * a public "thanks, we are looking at it" tells the world where to look. The
 * answer is silence plus a private escalation, and this is the function that
 * says so everywhere rather than each caller remembering.
 */
export function mayBeAnsweredPublicly(triage: Triage): boolean {
  return triage.classification !== 'security'
}

export const FAULTS = ['ours', 'theirs', 'unclear'] as const
// TEMPORARY: read by the machine that acts on a verdict, in a later commit.
// fallow-ignore-next-line unused-type
export type Fault = (typeof FAULTS)[number]

/**
 * Whether a failing check is this change's fault.
 *
 * Its own decision with its own evidence, in front of every revision, because
 * getting it wrong spends a budget on somebody else's outage and eventually
 * abandons a correct pull request over a flaky runner.
 */
export const faultSchema = z.object({
  fault: z.enum(FAULTS),
  /** One line a person can read without opening the failing job. */
  summary: looseText,
  reasoning: looseText,
  /** What in the log led to this, quoted rather than described. */
  evidence: looseList,
})

export type FaultVerdict = z.infer<typeof faultSchema>

/**
 * Whether to spend a fix on this.
 *
 * `unclear` counts as theirs, and that asymmetry is the design rather than
 * caution. Being wrong this way leaves a pull request open with a comment
 * saying the checks failed for a reason we could not tie to the change, which
 * a person can read and act on. Being wrong the other way rewrites working
 * code against a failure it did not cause, and does it twice before stopping.
 */
export function isOurFault(verdict: FaultVerdict): boolean {
  return verdict.fault === 'ours'
}
