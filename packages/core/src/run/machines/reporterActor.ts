import { fromCallback } from 'xstate'
import { listIssueCommentBodies } from '@/lib/gh'
import { logger } from '@/lib/log'
import { releasingGate } from '@/modules/outbound/deliver'
import { queueOutbound } from '@/modules/work/store'
import { runDeps } from './deps'

const log = logger('reporter')

/** How often a parked run looks for an answer. Minutes, because weeks are the unit. */
const POLL_MS = 5 * 60_000
/** How long to wait before asking once more. */
const NUDGE_AFTER_MS = 7 * 24 * 60 * 60_000
/** How long after the nudge before giving up. */
const STALE_AFTER_MS = 14 * 24 * 60 * 60_000

interface ReporterInput {
  readonly runId: string
  readonly repo: string
  readonly issue: number
  /** When the question was asked, which everything is measured from. */
  readonly askedAt: string
  readonly pollMs?: number
  readonly nudgeAfterMs?: number
  readonly staleAfterMs?: number
  /** Whether the one follow up was already sent, before this watch existed. */
  readonly alreadyNudged?: boolean
}

/**
 * Waits for someone who does not work for you.
 *
 * The gate pattern pointed at a stranger, and different from it in the three
 * ways that matter. It lasts weeks rather than minutes, so it has to survive
 * restarts, which it gets from the snapshot and from measuring everything
 * against a timestamp rather than against a timer. It is woken by a comment on
 * the issue rather than by a row anybody here controls. And it gives up, because
 * closing without ever asking again is rude and asking forever is worse.
 *
 * Waking is not proceeding. A reply can make an issue less actionable rather
 * than more, so this reports that the reporter spoke and the machine decides
 * what that means by classifying again.
 */
export const reporterWatch = fromCallback<{ type: string }, ReporterInput>(
  ({ input, sendBack }) => {
    let stopped = false
    // Carried in rather than starting false: this actor is rebuilt after every
    // nudge, and a fresh one would send a second, and a third, and never reach
    // the threshold where it gives up.
    let nudged = input.alreadyNudged === true
    let timer: ReturnType<typeof setInterval> | undefined

    // Read from the run rather than carried through the context: the issue is
    // already there, and the author of it is who was asked.
    const reporter = runDeps(input.runId).issue.user?.login ?? ''
    const asked = Date.parse(input.askedAt)
    const nudgeAfter = input.nudgeAfterMs ?? NUDGE_AFTER_MS
    const staleAfter = input.staleAfterMs ?? STALE_AFTER_MS

    const look = async (): Promise<void> => {
      if (stopped) {
        return
      }
      const comments = await listIssueCommentBodies(input.repo, input.issue)
      if (stopped) {
        return
      }

      // Only the person who was asked, and only after they were asked. Someone
      // else chiming in is not the answer to a question they were not asked.
      const answer = comments.find(
        (comment) =>
          comment.author === reporter && Date.parse(comment.created_at) > asked,
      )
      if (answer !== undefined) {
        log.info('the reporter answered', {
          repo: input.repo,
          issue: input.issue,
        })
        sendBack({ type: 'REPORTER_REPLIED', body: answer.body })
        return
      }

      const waited = Date.now() - asked
      if (!nudged && waited > nudgeAfter) {
        nudged = true
        log.info('asking the reporter once more', {
          repo: input.repo,
          issue: input.issue,
        })
        // Queued, not posted, like everything else outbound, and riding on the
        // answer that released the original question. Without that it would be
        // refused by delivery and the reporter would never hear from us again.
        const deps = runDeps(input.runId)
        const releasing = releasingGate(deps.db, input.runId)
        await queueOutbound(deps.run, {
          kind: 'comment_on_issue',
          body: 'Following up on the question above. Without that detail this cannot be looked into, and it will be closed in a fortnight.',
          station: 'classifier',
          queuedAt: new Date().toISOString(),
          ...(releasing === undefined ? {} : { gateId: releasing }),
        })
        sendBack({ type: 'REPORTER_NUDGED' })
        return
      }

      if (waited > staleAfter) {
        log.info('closing as stale, nobody answered', {
          repo: input.repo,
          issue: input.issue,
        })
        sendBack({ type: 'REPORTER_SILENT' })
      }
    }

    const tick = (): void => {
      void look().catch((error: unknown) => {
        // A run that lasts weeks outlives any one failed request.
        log.debug('could not check for a reply', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }

    tick()
    timer = setInterval(tick, input.pollMs ?? POLL_MS)

    return () => {
      stopped = true
      if (timer !== undefined) {
        clearInterval(timer)
      }
    }
  },
)
