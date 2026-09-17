import { streamText } from 'ai'
import { createAcpxProvider } from 'acpx-ai-provider'
import type { Config } from '@/config'
import { logger, raw } from '@/lib/log'

const log = logger('agent')

// The provider implements LanguageModelV2, which the AI SDK accepts through a
// documented compatibility path. Its warning fires on every turn with a full
// stack trace and would bury the agent's own output, so it is silenced here
// rather than left to scroll past.
;(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false

export interface AgentTurnInput {
  readonly worktree: string
  readonly task: string
  readonly systemRules: string
  readonly config: Config
}

export interface AgentTurnResult {
  readonly report: string
  readonly finishReason: string
  readonly toolCalls: number
  readonly totalTokens: number | undefined
}

/**
 * Runs one agent turn inside the worktree.
 *
 * `permissionMode: 'approve-all'` is safe here only because of what surrounds it:
 * the agent is confined to a throwaway worktree, holds no GitHub credential, and
 * is told not to run git at all. Delivery happens outside this function, gated on
 * a real diff, so the worst outcome from a hijacked turn is a dirty worktree that
 * never ships.
 */
export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const { worktree, task, systemRules, config } = input

  const provider = createAcpxProvider({
    agent: config.agent,
    cwd: worktree,
    sessionMode: 'oneshot',
    permissionMode: 'approve-all',
    // Headless: an unexpected permission request is refused so the turn continues,
    // rather than hanging forever on a prompt nobody is there to answer.
    nonInteractivePermissions: 'deny',
    turnTimeoutMs: config.turnTimeoutMs,
    sessionOptions: { systemPrompt: { append: systemRules } },
  })

  try {
    try {
      await provider.setConfigOption('reasoning_effort', config.reasoningEffort)
    } catch (error) {
      // Optional control method; not every ACP adapter implements it.
      log.debug('reasoning_effort not applied', { error })
    }

    const result = streamText({
      model: provider.languageModel(),
      messages: [{ role: 'user', content: task }],
      abortSignal: AbortSignal.timeout(config.turnTimeoutMs),
    })

    let report = ''
    let toolCalls = 0
    let streamingText = false

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'reasoning-delta':
          log.debug('thinking', { text: part.text.slice(0, 120) })
          break
        case 'tool-call':
          toolCalls += 1
          log.info(`tool ${part.toolName}`, { call: toolCalls })
          break
        case 'text-delta':
          if (!streamingText) {
            streamingText = true
            log.info('agent report')
          }
          report += part.text
          raw(part.text)
          break
        case 'error':
          log.error('stream error', { error: part.error })
          break
        default:
          break
      }
    }
    if (streamingText) {
      raw('\n')
    }

    const [finishReason, usage] = await Promise.all([result.finishReason, result.totalUsage])
    return {
      report: report.trim(),
      finishReason,
      toolCalls,
      totalTokens: usage.totalTokens,
    }
  } finally {
    await provider.close()
  }
}
