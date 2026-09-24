import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { StationId } from '@/events/events.types'
import {
  appendConversation,
  findArtifacts,
  readArtifact,
} from '@/modules/work/artifacts'
import { queueOutbound } from '@/modules/work/store'
import { recordAnalysis, recordReview } from '@/run/artifacts'
import { analysisSchema, reviewSchema } from '@/run/stations/schemas'
import type { ToolContext } from './context'

/**
 * The tools a station may call, and nothing else.
 *
 * Which tools exist for a session is the enforcement. The implementer cannot
 * write a plan and the reviewer cannot rewrite the criteria it is grading
 * against, because those tools are never registered for them. Tool annotations
 * are not the lever here: the specification is explicit that they are hints
 * and that a client must not make tool use decisions from them.
 */

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] }
}

function registerWritePlan(server: McpServer, ctx: ToolContext): void {
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
    },
    async (input) => {
      const analysis = analysisSchema.parse(input)
      const written = await recordAnalysis(
        ctx.subject,
        ctx.run,
        { number: ctx.subject.number, title: ctx.title },
        analysis,
      )
      return text(
        `recorded ${written.plan.id} (version ${written.plan.version}) and ${written.criteria.id} with ${analysis.acceptance_criteria.length} criteria`,
      )
    },
  )
}

function registerWriteReview(server: McpServer, ctx: ToolContext): void {
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
      const review = reviewSchema.parse(input)
      const written = await recordReview(
        ctx.subject,
        ctx.run,
        { number: ctx.subject.number, title: ctx.title },
        review,
      )
      const passed = review.criteria_results.filter((r) => r.pass).length
      return text(
        `recorded ${written.review.id} (version ${written.review.version}): ${review.verdict}, ${passed}/${review.criteria_results.length} criteria met`,
      )
    },
  )
}

function registerRecall(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'find_artifacts',
    {
      title: 'Find earlier artifacts',
      description:
        'List plans, criteria, reviews and notes already recorded for this subject or repository. Returns ids and titles, not bodies. Read one with read_artifact.',
      inputSchema: {
        kind: z
          .enum(['plan', 'criteria', 'review', 'note'])
          .optional()
          .describe('Narrow to one kind. Omit for everything.'),
        scope: z
          .enum(['subject', 'repository'])
          .default('subject')
          .describe('This issue, or everything in the repository.'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ kind, scope, limit }) => {
      const refs = await findArtifacts({
        ...(scope === 'subject'
          ? { subject: ctx.subject }
          : { repo: ctx.subject.repo }),
        ...(kind === undefined ? {} : { kind }),
        limit,
      })
      if (refs.length === 0) {
        return text('nothing recorded yet')
      }
      return text(
        refs.map((r) => `${r.id}  (${r.kind} v${r.version})`).join('\n'),
      )
    },
  )

  server.registerTool(
    'read_artifact',
    {
      title: 'Read one artifact',
      description:
        'Read the full text of an artifact by the id find_artifacts gave you.',
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const body = await readArtifact(id)
      return body === undefined ? text(`no artifact at ${id}`) : text(body)
    },
  )
}

function registerConversation(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'append_conversation',
    {
      title: 'Add to the discussion',
      description:
        'Append a note to this subject’s running discussion. Use it to record a decision or a question that the next station, or a person, should see.',
      inputSchema: { body: z.string().min(1) },
    },
    async ({ body }) => {
      await appendConversation(ctx.subject, ctx.station, body)
      return text('appended to the conversation')
    },
  )
}

function registerOutbound(server: McpServer, ctx: ToolContext): void {
  const queue =
    (kind: 'comment_on_issue' | 'reply_to_review') =>
    async (input: { body: string; threadId?: string }) => {
      await queueOutbound(ctx.run, {
        kind,
        body: input.body,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        station: ctx.station,
        queuedAt: new Date().toISOString(),
      })
      return text(
        'queued. aalai sends this once the run reaches a point where it may speak.',
      )
    }

  server.registerTool(
    'comment_on_issue',
    {
      title: 'Queue a comment on the issue',
      description:
        'Queue something to say on the issue. It is not sent now: aalai delivers it when the run is allowed to speak.',
      inputSchema: { body: z.string().min(1) },
    },
    queue('comment_on_issue'),
  )

  server.registerTool(
    'reply_to_review',
    {
      title: 'Queue a reply to a review thread',
      description:
        'Queue a reply to a review comment. It is not sent now: aalai delivers it when the run is allowed to speak.',
      inputSchema: { threadId: z.string().min(1), body: z.string().min(1) },
    },
    queue('reply_to_review'),
  )
}

/** Tool names a station is given, which is the whole access control. */
export const STATION_TOOLS: Record<StationId, readonly string[]> = {
  analyst: [
    'write_plan',
    'find_artifacts',
    'read_artifact',
    'append_conversation',
  ],
  implementer: ['find_artifacts', 'read_artifact', 'append_conversation'],
  reviewer: [
    'write_review',
    'find_artifacts',
    'read_artifact',
    'append_conversation',
  ],
}

export function registerStationTools(
  server: McpServer,
  ctx: ToolContext,
): void {
  const allowed = new Set(STATION_TOOLS[ctx.station] ?? [])
  if (allowed.has('write_plan')) registerWritePlan(server, ctx)
  if (allowed.has('write_review')) registerWriteReview(server, ctx)
  if (allowed.has('find_artifacts')) registerRecall(server, ctx)
  if (allowed.has('append_conversation')) registerConversation(server, ctx)
  registerOutbound(server, ctx)
}
