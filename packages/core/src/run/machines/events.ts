import type { GateDecision } from '@/modules/db/schema/schema'

/**
 * Everything sent into the work machine from outside a station.
 *
 * Declared so the machine knows them, which is what lets a guard read
 * `event.decision` directly instead of every transition restating the shape
 * through a params mapper.
 */
export type IssueWorkEvent =
  | { type: 'PREMISE_ABORT'; reason: string }
  | { type: 'PREMISE_REPLAN'; reason: string; body: string }
  | { type: 'GATE_OPENED'; gateId: string }
  | {
      type: 'GATE_ANSWERED'
      gateId: string
      decision: GateDecision
      reason: string
    }
  | { type: 'GATE_SUPERSEDED'; gateId: string }
