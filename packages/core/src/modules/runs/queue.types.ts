import type { RunStatus, SubjectKind } from '@/modules/db/schema/runs.sql'
import type { RunPolicy } from '@/shared/modes'

/** One row of the claim table, as everything outside the queue reads it. */
export interface QueueEntry {
  readonly repo: string
  readonly kind: SubjectKind
  readonly number: number
  readonly status: RunStatus
  readonly title: string | null
  readonly offeredAt: string | null
  readonly queuedAt: string | null
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly branch: string | null
  readonly prUrl: string | null
  readonly error: string | null
  /** The mode chosen for this one run, or null to go by the repository's. */
  readonly policy: RunPolicy | null
}
