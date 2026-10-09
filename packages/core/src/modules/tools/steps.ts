import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { emit } from '@/events/bus'
import type { ToolContext } from './context'
import {
  answerReviewInput,
  answerReviewOutput,
  coherentProgress,
  finishStepInput,
  finishStepOutput,
  reportContextInput,
  reportContextOutput,
  reportProgressInput,
  reportProgressOutput,
  startStepInput,
  startStepOutput,
} from './defs/schemas'
import { recordedReply as reply } from './reply'

/**
 * The tools that tell the interface what is happening.
 *
 * Nothing here writes to disk. Each one validates, emits the event its screen
 * is waiting for, and hands back the same values as structured output, so the
 * agent reads a sentence and the interface reads an object rather than both
 * parsing the same prose.
 *
 * A tool call and the pixel it moves are emitted from the same function on
 * purpose. Recording the step in one place and announcing it in another is how
 * the two drift.
 */

export function registerStepTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'start_step',
    {
      title: 'Begin a step of the plan',
      description:
        'Say which step of the approved plan you are starting. Call this before the work, so a person watching knows what is happening rather than that something is.',
      inputSchema: startStepInput,
      outputSchema: startStepOutput.shape,
    },
    ({ step_index }) => {
      const startedAt = new Date().toISOString()
      emit({
        type: 'step.started',
        runId: ctx.runId,
        at: Date.now(),
        station: ctx.station,
        stepIndex: step_index,
      })
      return reply(`started step ${step_index}`, {
        stepIndex: step_index,
        startedAt,
      })
    },
  )

  server.registerTool(
    'report_progress',
    {
      title: 'Say how far through a step you are',
      description:
        'Report progress inside a step that takes more than a moment, as a count of whatever it is doing. Call it as the count changes, not once at the end: a step that reports nothing for five minutes is indistinguishable from one that has hung.',
      inputSchema: reportProgressInput,
      outputSchema: reportProgressOutput.shape,
    },
    ({ step_index, label, unit, done, total }) => {
      if (!coherentProgress({ done, total })) {
        // An error result rather than a shaped one. Answering with
        // `done: total` would have had a client draw a finished bar for the
        // very report that was refused, which is the thing this guards against.
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `refused: ${done} of ${total} is not a position inside the work. Report a count no greater than the total.`,
            },
          ],
        }
      }
      emit({
        type: 'step.progress',
        runId: ctx.runId,
        at: Date.now(),
        station: ctx.station,
        stepIndex: step_index,
        label,
        unit,
        done,
        total,
      })
      return reply(`${done} of ${total} ${unit}`, {
        stepIndex: step_index,
        done,
        total,
        ratio: done / total,
      })
    },
  )

  server.registerTool(
    'finish_step',
    {
      title: 'Finish a step of the plan',
      description:
        'Say what the step did in one sentence and name the files it changed. The sentence and the files are what a person reads in the thread, so write the sentence for them rather than for a log.',
      inputSchema: finishStepInput,
      outputSchema: finishStepOutput.shape,
    },
    ({ step_index, summary, files }) => {
      emit({
        type: 'step.finished',
        runId: ctx.runId,
        at: Date.now(),
        station: ctx.station,
        stepIndex: step_index,
        summary,
        files,
      })
      return reply(
        `finished step ${step_index}, ${files.length} file${files.length === 1 ? '' : 's'} changed`,
        { stepIndex: step_index, summary, files },
      )
    },
  )
}

/**
 * What the repository told you before you started.
 *
 * The honest answer to "did it read AGENTS.md". Asking git tells you the file
 * exists, which is a different question from whether the agent opened it, and
 * a file reported missing is worth more than one silently skipped.
 */
export function registerContextTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'report_context',
    {
      title: 'Record which instruction files you read',
      description:
        "Record the repository's own instruction files and whether each one was there. Call this once, before planning, after looking for them.",
      inputSchema: reportContextInput,
      outputSchema: reportContextOutput.shape,
    },
    ({ files }) => {
      const found = files.filter((file) => file.found).length
      ctx.context = files
      // Emitted as well as held on the turn. The grant is revoked when the
      // turn ends and `runStation` does not return this, so without the event
      // the report would be collected and then thrown away.
      emit({
        type: 'context.read',
        runId: ctx.runId,
        at: Date.now(),
        station: ctx.station,
        files: files.map((file) => ({
          path: file.path,
          found: file.found,
          bytes: file.bytes,
        })),
      })
      return reply(
        `recorded ${found} of ${files.length} instruction files as read`,
        { found, missing: files.length - found, total: files.length },
      )
    },
  )
}

export function registerReviewAnswerTool(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    'answer_review_comment',
    {
      title: 'Answer one review comment',
      description:
        'Record your answer to a review comment, and the commit that addressed it when there is one. Nothing is posted by this tool.',
      inputSchema: answerReviewInput,
      outputSchema: answerReviewOutput.shape,
    },
    ({ thread_id, answer, commit_sha }) => {
      const answeredAt = new Date().toISOString()
      ctx.answered.push({
        threadId: thread_id,
        answer,
        answeredAt,
        commitSha: commit_sha ?? null,
      })
      // Same reason as the context report: the grant does not outlive the
      // turn, so an answer that only lives on it is an answer nobody sees.
      emit({
        type: 'review.answered',
        runId: ctx.runId,
        at: Date.now(),
        station: ctx.station,
        threadId: thread_id,
        answer,
        commitSha: commit_sha ?? null,
      })
      return reply('recorded for a person to read. Nothing is posted by you.', {
        threadId: thread_id,
        answeredAt,
        commitSha: commit_sha ?? null,
      })
    },
  )
}
