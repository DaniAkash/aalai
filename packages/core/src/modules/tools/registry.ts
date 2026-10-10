import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { StationId } from '@/events/events.types'
import {
  appendConversation,
  findArtifacts,
  readArtifact,
} from '@/modules/work/artifacts'
import { parseArtifactId, repoSegment } from '@/modules/work/paths'
import { queueOutbound } from '@/modules/work/store'
import type { ToolContext } from './context'
import {
  registerWritePlan,
  registerWriteReview,
  registerWriteTriage,
} from './records'
import { text } from './reply'
import {
  registerContextTool,
  registerReviewAnswerTool,
  registerStepTools,
} from './steps'

/**
 * The tools a station may call, and nothing else.
 *
 * Which tools exist for a session is the enforcement. The implementer cannot
 * write a plan and the reviewer cannot rewrite the criteria it is grading
 * against, because those tools are never registered for them. Tool annotations
 * are not the lever here: the specification is explicit that they are hints
 * and that a client must not make tool use decisions from them.
 */

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
      // Parsed, not prefix matched. A prefix check runs against the raw id and
      // `acme__widgets/../other__repo/...` passes it, so the repository has to
      // be read out of an id whose whole shape was validated first. This also
      // keeps run internals unreachable: a snapshot or an attempt outcome is
      // not an artifact id and never parses as one.
      const parsed = parseArtifactId(id)
      if (parsed?.repoSegment !== repoSegment(ctx.subject.repo)) {
        return text(`no artifact at ${id}`)
      }
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
    (kind: 'comment_on_issue') =>
    async (input: { body: string; threadId?: string }) => {
      const intent = {
        kind,
        body: input.body,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        station: ctx.station,
        queuedAt: new Date().toISOString(),
      } as const
      await queueOutbound(ctx.run, intent)
      ctx.queued.push(intent)
      // Triage and the review loop drain an outbox. An intent from anywhere
      // else is queued after the handoff, bound to no gate, and delivered by
      // nobody, so a station there is told plainly rather than left to assume.
      return text(
        ctx.station === 'classifier'
          ? 'recorded for a person to review. Nothing is posted to GitHub by this tool. If a person releases it, it is sent afterwards, and you are not told either way.'
          : 'recorded for a person to read. Nothing is posted to GitHub by this tool and nothing delivers it yet, so do not rely on the reporter seeing it.',
      )
    }

  server.registerTool(
    'comment_on_issue',
    {
      title: 'Queue a comment on the issue',
      description:
        'Record something you would say on the issue. It is written down for a person to read and is never posted by you. At most it is sent after your turn has ended, so do not expect a reply.',
      inputSchema: { body: z.string().min(1) },
    },
    queue('comment_on_issue'),
  )
}

export const STATION_TOOLS: Record<StationId, readonly string[]> = {
  classifier: [
    'write_triage',
    'report_context',
    'find_artifacts',
    'read_artifact',
    'append_conversation',
  ],
  analyst: [
    'write_plan',
    'report_context',
    'find_artifacts',
    'read_artifact',
    'append_conversation',
  ],
  // The step tools and not write_plan: the implementer reports against the
  // plan it was handed and cannot rewrite the thing it is being measured by.
  implementer: [
    'start_step',
    'report_progress',
    'finish_step',
    'find_artifacts',
    'read_artifact',
    'append_conversation',
  ],
  // answer_review_comment and not the step tools: answering a comment is a
  // different act from executing a plan step.
  reviewer: [
    'write_review',
    'answer_review_comment',
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
  if (allowed.has('write_triage')) registerWriteTriage(server, ctx)
  if (allowed.has('write_plan')) registerWritePlan(server, ctx)
  if (allowed.has('write_review')) registerWriteReview(server, ctx)
  if (allowed.has('start_step')) registerStepTools(server, ctx)
  if (allowed.has('report_context')) registerContextTool(server, ctx)
  if (allowed.has('answer_review_comment'))
    registerReviewAnswerTool(server, ctx)
  if (allowed.has('find_artifacts')) registerRecall(server, ctx)
  if (allowed.has('append_conversation')) registerConversation(server, ctx)
  registerOutbound(server, ctx)
}
