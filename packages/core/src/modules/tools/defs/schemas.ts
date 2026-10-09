import { z } from 'zod'

/**
 * The shapes the interface positions something from.
 *
 * Deliberately stricter than the station schemas next door. Those are lenient
 * about prose because a run should not fail over a station writing its test
 * strategy as a list, and that leniency is right. These are different: a step
 * index chooses which row highlights and a count sets the width of a bar, so a
 * value that is merely plausible draws the wrong thing. A lenient step index
 * is a progress bar that jumps backwards.
 */

const fileChangeSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['added', 'modified', 'deleted']),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
})

/** A step of the plan currently in force, indexed from zero. */
const stepIndexSchema = z
  .number()
  .int()
  .min(0)
  .describe('Which step of the approved plan this is, counting from zero.')

export const startStepInput = {
  step_index: stepIndexSchema,
  label: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe(
      'What this step does, in a few words. The work list shows it where there is no room for the plan, so write it as a person would read it: "Run the test suite", not "step 3".',
    ),
}

export const startStepOutput = z.object({
  stepIndex: z.number().int().min(0),
  startedAt: z.string(),
})

export const reportProgressInput = {
  step_index: stepIndexSchema,
  label: z
    .string()
    .min(1)
    .describe('What is running, shown to a person verbatim: `bun test`.'),
  unit: z.string().min(1).describe('What is being counted: `files`, `tests`.'),
  done: z.number().int().min(0),
  total: z.number().int().min(1),
}

export const reportProgressOutput = z.object({
  stepIndex: z.number().int().min(0),
  done: z.number().int().min(0),
  total: z.number().int().min(1),
  ratio: z.number().min(0).max(1),
})

export const finishStepInput = {
  step_index: stepIndexSchema,
  summary: z
    .string()
    .min(1)
    .describe('One sentence saying what this step did.'),
  files: z.array(fileChangeSchema).default([]),
}

export const finishStepOutput = z.object({
  stepIndex: z.number().int().min(0),
  summary: z.string().min(1),
  files: z.array(fileChangeSchema),
})

export const reportContextInput = {
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        found: z.boolean(),
        bytes: z.number().int().min(0).default(0),
      }),
    )
    .min(1),
}

export const reportContextOutput = z.object({
  found: z.number().int().min(0),
  missing: z.number().int().min(0),
  total: z.number().int().min(0),
})

export const answerReviewInput = {
  thread_id: z.string().min(1),
  answer: z.string().min(1),
  commit_sha: z.string().min(1).optional(),
}

export const answerReviewOutput = z.object({
  threadId: z.string().min(1),
  answeredAt: z.string(),
  commitSha: z.string().nullable(),
})

/**
 * Rejects a report that cannot be true before anything is drawn from it.
 *
 * It cannot tell whether a true-looking report is accurate: progress is the
 * agent's own account of itself, which is the right thing to show a person and
 * the wrong thing to trust. What it can do is refuse the incoherent one.
 */
export function coherentProgress(input: {
  done: number
  total: number
}): boolean {
  return input.done <= input.total
}
