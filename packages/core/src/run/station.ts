import { createAcpxProvider } from 'acpx-ai-provider'
import { streamText } from 'ai'
import type { Config } from '@/config'
import { emit } from '@/events/bus'
import type { StationId } from '@/events/events.types'
import { logger, raw } from '@/lib/log'
import { getDb } from '@/modules/db/db'
import {
  readStationSession,
  rememberSession,
  sessionKeyFor,
} from '@/modules/sessions/sessions'

// The provider implements LanguageModelV2, which the AI SDK accepts through a
// documented compatibility path. Its warning fires on every turn with a full
// stack trace and would bury the agent's own output, so it is silenced here
// rather than left to scroll past.
;(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false

export type StationPermission = 'approve-all' | 'approve-reads'

export interface StationInput {
  /** Which ACP agent drives this station. */
  readonly agent: string
  /** The run this station belongs to, so its activity reaches anything watching. */
  readonly runId: string
  readonly station: StationId
  /** Shown in the log, so a run reads as a pipeline rather than one blob. */
  readonly label: string
  readonly worktree: string
  readonly systemRules: string
  readonly task: string
  /**
   * `approve-reads` is how a station that must not modify anything is stopped
   * from doing so. The analyst and the reviewer both run under it, which makes
   * "the analyst plans, it does not implement" a property of the run rather
   * than a line in a prompt.
   */
  readonly permission: StationPermission
  readonly config: Config
}

export interface StationResult {
  readonly text: string
  readonly finishReason: string
  readonly toolCalls: number
  readonly totalTokens: number | undefined
  /** Tool names in call order. The eval suite asserts on this, not on prose. */
  readonly trace: readonly string[]
}

/**
 * Runs one station: a single turn of one ACP agent inside a working directory.
 *
 * Every station goes through here, so the properties that matter hold for all
 * of them: a disposable working directory, a session keyed to this run and
 * this station, headless permission handling, and a turn timeout.
 */
/**
 * Drains one turn's stream into the text it produced and the tools it called.
 *
 * Separate from runStation because the switch over part types is most of the
 * branching in this file, and the turn's setup and teardown read better
 * without it in the middle.
 */
async function consumeStream(
  stream: ReturnType<typeof streamText>['fullStream'],
  input: StationInput,
  log: ReturnType<typeof logger>,
): Promise<{ text: string; trace: string[] }> {
  let text = ''
  const trace: string[] = []
  let streaming = false
  // A station narrates between tool calls, and those fragments arrive as
  // separate text runs. Without a break they concatenate into one run-on
  // paragraph in the report.
  let brokeForTool = false

  for await (const part of stream) {
    switch (part.type) {
      case 'reasoning-delta':
        log.debug('thinking', { text: part.text.slice(0, 120) })
        break
      case 'tool-call':
        brokeForTool = streaming
        trace.push(part.toolName)
        log.info(`tool ${part.toolName}`, { call: trace.length })
        emit({
          type: 'agent.tool',
          runId: input.runId,
          station: input.station,
          tool: part.toolName,
          at: Date.now(),
        })
        break
      case 'text-delta':
        if (!streaming) {
          streaming = true
          log.info('report')
        }
        if (brokeForTool) {
          text += '\n\n'
          brokeForTool = false
        }
        text += part.text
        raw(part.text)
        break
      case 'error':
        log.error('stream error', { error: part.error })
        break
      default:
        break
    }
  }
  if (streaming) {
    raw('\n')
  }
  return { text, trace }
}

export async function runStation(input: StationInput): Promise<StationResult> {
  const log = logger(input.label)
  const { sqlite } = getDb()
  const sessionKey = sessionKeyFor(input.runId, input.station)
  const previous = readStationSession(sqlite, input.runId, input.station)

  const provider = createAcpxProvider({
    agent: input.agent,
    cwd: input.worktree,
    // Persistent and keyed, so a station re-entered by a revision resumes its
    // own context instead of starting cold. stateDir is deliberately unset:
    // acpx defaults under ~/.acpx and owns what it keeps there.
    sessionMode: 'persistent',
    sessionKey,
    ...(previous?.acpxSessionId === null ||
    previous?.acpxSessionId === undefined
      ? {}
      : { resumeSessionId: previous.acpxSessionId }),
    permissionMode: input.permission,
    // Headless: an unexpected permission request is refused so the turn
    // continues, rather than hanging on a prompt nobody is there to answer.
    nonInteractivePermissions: 'deny',
    turnTimeoutMs: input.config.turnTimeoutMs,
    sessionOptions: { systemPrompt: { append: input.systemRules } },
  })

  try {
    try {
      await provider.setConfigOption(
        'reasoning_effort',
        input.config.reasoningEffort,
      )
    } catch (error) {
      log.debug('reasoning_effort not applied', { error })
    }

    const result = streamText({
      model: provider.languageModel(),
      messages: [{ role: 'user', content: input.task }],
      abortSignal: AbortSignal.timeout(input.config.turnTimeoutMs),
    })

    const { text, trace } = await consumeStream(result.fullStream, input, log)

    const [finishReason, usage] = await Promise.all([
      result.finishReason,
      result.totalUsage,
    ])
    // Before close, which is the only point where the handle is still live.
    await rememberSession(sqlite, provider, input.runId, input.station)
    return {
      text: text.trim(),
      finishReason,
      toolCalls: trace.length,
      totalTokens: usage.totalTokens,
      trace,
    }
  } finally {
    await provider.close()
  }
}
