import { reviewGate } from '@/run/gate'
import type { IssueWorkContext } from './types'

/**
 * Why a run stopped when the verdict was neither an approval nor a rejection.
 *
 * An approve that fails the gate is a malformed approval rather than a change
 * request: sending it back would ask the implementer to fix nothing.
 */
export function stopReason(context: IssueWorkContext): string {
  if (context.review?.verdict === 'approve' && context.analysis !== undefined) {
    const gate = reviewGate(context.review, context.analysis)
    if (!gate.ok) {
      return gate.reason
    }
  }
  return `the reviewer still requested changes after ${context.maxRevisions} revisions`
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
