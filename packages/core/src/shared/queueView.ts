import type { RunStatus } from '@/modules/db/schema/schema'

export interface StatusTab {
  readonly key: RunStatus | 'all'
  readonly label: string
}

/**
 * The statuses a person filters by, in the order they care about them.
 *
 * `offered` is absent on purpose. An offer is a question, and questions live in
 * the inbox; putting them here too would make the queue look full of work
 * nobody asked for, which is the impression this whole change exists to undo.
 */
export const STATUS_TABS: readonly StatusTab[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'blocked', label: 'Needs you' },
  { key: 'stopped', label: 'Stopped' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'failed', label: 'Failed' },
]

/** What an empty tab should say, which is different for each of them. */
export function emptyQueueCopy(key: RunStatus | 'all'): string {
  switch (key) {
    case 'running':
      return 'No run holds a slot right now.'
    case 'queued':
      return 'Nothing is waiting. New issues and pull requests arrive in the inbox, where you decide what gets queued.'
    case 'blocked':
      return 'Nothing is waiting on you.'
    case 'stopped':
      return 'Nothing has been stopped.'
    case 'delivered':
      return 'Nothing has been delivered yet.'
    case 'failed':
      return 'Nothing has failed.'
    default:
      return 'The queue is empty. Add a repository and its issues and pull requests will arrive in the inbox.'
  }
}

/**
 * What the capacity meter says, in words.
 *
 * Paused is checked first because it is the one state where the numbers are
 * true and misleading at the same time: slots can be free and nothing will
 * start.
 */
export function capacityLine(input: {
  running: number
  capacity: number
  queued: number
  paused: boolean
}): string {
  if (input.paused) {
    return 'The queue is paused. Running work finishes; nothing new starts.'
  }
  if (input.queued === 0) {
    return 'Nothing is waiting. A free slot takes the next thing you queue.'
  }
  const waiting = `${input.queued} waiting for a slot`
  return input.running >= input.capacity
    ? `${waiting}. Every slot is busy.`
    : `${waiting}.`
}

/** How a person reads a run's state when it is one word on a row. */
export function statusLabel(status: RunStatus): string {
  switch (status) {
    case 'offered':
      return 'offered'
    case 'blocked':
      return 'needs you'
    case 'delivered':
      return 'delivered'
    default:
      return status
  }
}
