import type {
  GateDecision,
  GateKind,
  GateRow,
  GateStatus,
} from '@/modules/db/schema/schema'

/** Where an answer came from, which a person needs to see on the thread. */
export const ANSWER_SOURCES = ['cli', 'app', 'github'] as const
export type AnswerSource = (typeof ANSWER_SOURCES)[number]

export interface OpenGateInput {
  readonly runId: string
  readonly kind: GateKind
  readonly artifactPath?: string
  readonly artifactVersion?: string
}

export interface AnswerGateInput {
  readonly gateId: string
  readonly decision: GateDecision
  readonly reason?: string
  readonly answeredBy: string
  readonly answeredOn: AnswerSource
}

/**
 * Why an answer did not take.
 *
 * A refusal is an ordinary outcome rather than an exception: three surfaces
 * can answer the same gate and two of them racing is expected, so the caller
 * renders what happened instead of showing a stack trace.
 */
export type AnswerRefusal =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'already_answered'; readonly gate: GateRow }
  | { readonly kind: 'superseded'; readonly gate: GateRow }

export type AnswerResult =
  | { readonly ok: true; readonly gate: GateRow }
  | { readonly ok: false; readonly refusal: AnswerRefusal }

export interface GateQuery {
  readonly status?: GateStatus
  readonly runId?: string
  readonly limit?: number
}
