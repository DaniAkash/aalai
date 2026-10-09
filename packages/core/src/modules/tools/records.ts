import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { redactDeep } from '@/lib/redact'
import { recordAnalysis, recordReview, recordTriage } from '@/run/artifacts'
import {
  analysisSchema,
  reviewSchema,
  triageSchema,
} from '@/run/stations/schemas'
import { CLASSIFICATIONS, CONFIDENCES } from '@/shared/triageView'
import type { ToolContext } from './context'
import { artifactWritten, recordedReply } from './reply'

/**
 * The tools that write a station's verdict down.
 *
 * Split from the registry because they are the three longest and they share
 * one shape: validate, record a versioned artifact, hand back both the
 * sentence and the object.
 */

export function registerWritePlan(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'write_plan',
    {
      title: 'Record the implementation plan',
      description:
        'Record the plan and how you intend to approach the work. Call this instead of writing the plan as prose. A new call records a new version; it never overwrites an earlier one.',
      inputSchema: {
        problem_statement: z.string().min(1),
        approach: z.string().min(1),
        plan: z.array(z.string().min(1)).min(1),
        affected_surface: z.array(z.string()),
        risks: z.array(z.string()),
        test_strategy: z.string().min(1),
        acceptance_criteria: z.array(z.string().min(1)).min(1),
      },
      outputSchema: { ...artifactWritten, criteria: z.number().int() },
    },
    async (input) => {
      const analysis = analysisSchema.parse(input)
      const recorded = await recordAnalysis(
        ctx.subject,
        ctx.run,
        { number: ctx.subject.number, title: ctx.title },
        analysis,
      )
      ctx.written.push(recorded.plan, recorded.criteria)
      ctx.recorded.analysis = analysis
      return recordedReply(
        `recorded ${recorded.plan.id} (version ${recorded.plan.version}) and ${recorded.criteria.id} with ${analysis.acceptance_criteria.length} criteria`,
        {
          artifactId: recorded.plan.id,
          version: recorded.plan.version,
          criteria: analysis.acceptance_criteria.length,
        },
      )
    },
  )
}

export function registerWriteReview(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'write_review',
    {
      title: 'Record the review verdict',
      description:
        'Record your verdict with one result per acceptance criterion. Call this instead of writing the verdict as prose.',
      inputSchema: {
        verdict: z.enum(['approve', 'request_changes', 'reject']),
        criteria_results: z
          .array(
            z.object({
              criterion: z.string().min(1),
              pass: z.boolean(),
              evidence: z.string().min(1),
            }),
          )
          .min(1),
        blocking_findings: z.array(z.string()),
        summary: z.string().min(1),
      },
    },
    async (input) => {
      // Redacted here rather than after, because this is what gets written.
      // The station path redacts what it returns, but a tool recorded review
      // skips that write, so without this the artifact on disk keeps local
      // worktree paths that a person and later the brain will read.
      const review = redactDeep(reviewSchema.parse(input), ctx.worktreePath)
      const recorded = await recordReview(
        ctx.subject,
        ctx.run,
        { number: ctx.subject.number, title: ctx.title },
        review,
      )
      ctx.written.push(recorded.review)
      ctx.recorded.review = review
      const passed = review.criteria_results.filter((r) => r.pass).length
      return recordedReply(
        `recorded ${recorded.review.id} (version ${recorded.review.version}): ${review.verdict}, ${passed}/${review.criteria_results.length} criteria met`,
        {
          artifactId: recorded.review.id,
          version: recorded.review.version,
          verdict: review.verdict,
          passed,
          total: review.criteria_results.length,
        },
      )
    },
  )
}

export function registerWriteTriage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'write_triage',
    {
      title: 'Record what this issue is',
      description:
        'Record your classification of this issue and why. Call this instead of writing the verdict as prose. A new call records a new version; it never overwrites an earlier one.',
      inputSchema: {
        classification: z.enum(CLASSIFICATIONS),
        confidence: z.enum(CONFIDENCES),
        summary: z.string().min(1),
        reasoning: z.string().min(1),
        affected_surface: z.array(z.string()),
        duplicate_of: z.number().int().positive().optional(),
        reply: z.string().optional(),
        missing: z.array(z.string()),
      },
      outputSchema: {
        ...artifactWritten,
        classification: z.string(),
        confidence: z.string(),
      },
    },
    async (input) => {
      const triage = triageSchema.parse(input)
      const recorded = await recordTriage(
        ctx.subject,
        ctx.run,
        { number: ctx.subject.number, title: ctx.title },
        triage,
      )
      ctx.written.push(recorded)
      ctx.recorded.triage = triage
      return recordedReply(
        `recorded ${recorded.id} (version ${recorded.version}) as ${triage.classification} at ${triage.confidence} confidence`,
        {
          artifactId: recorded.id,
          version: recorded.version,
          classification: triage.classification,
          confidence: triage.confidence,
        },
      )
    },
  )
}

/** Tool names a station is given, which is the whole access control. */
