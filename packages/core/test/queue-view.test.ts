import { describe, expect, test } from 'bun:test'
import {
  capacityLine,
  emptyQueueCopy,
  STATUS_TABS,
  statusLabel,
} from '@/shared/queueView'

/**
 * The words on the capacity meter are the whole interface for a feature about
 * restraint, so they are pinned down here rather than left to whoever edits the
 * component next.
 */

describe('what the capacity meter says', () => {
  test('paused wins over the numbers, because free slots then mean nothing', () => {
    expect(
      capacityLine({ running: 0, capacity: 3, queued: 5, paused: true }),
    ).toContain('paused')
  })

  test('an empty queue says a slot is ready rather than reporting zero', () => {
    expect(
      capacityLine({ running: 1, capacity: 3, queued: 0, paused: false }),
    ).toContain('Nothing is waiting')
  })

  test('a full machine says so, so waiting is explained', () => {
    expect(
      capacityLine({ running: 3, capacity: 3, queued: 4, paused: false }),
    ).toContain('Every slot is busy')
  })

  test('room to spare says only how many are waiting', () => {
    const line = capacityLine({
      running: 1,
      capacity: 3,
      queued: 4,
      paused: false,
    })
    expect(line).toContain('4 waiting for a slot')
    expect(line).not.toContain('Every slot')
  })
})

describe('the status tabs', () => {
  test('offers are deliberately not one of them', () => {
    // An offer is a question and questions live in the inbox. Showing them here
    // would make the queue look full of work nobody asked for.
    expect(STATUS_TABS.map((t) => t.key)).not.toContain('offered')
  })

  test('what needs a person comes before what is merely finished', () => {
    const keys = STATUS_TABS.map((t) => t.key)
    expect(keys.indexOf('blocked')).toBeLessThan(keys.indexOf('delivered'))
  })

  test('every tab has copy for being empty', () => {
    for (const tab of STATUS_TABS) {
      expect(emptyQueueCopy(tab.key).length).toBeGreaterThan(10)
    }
  })

  test('an empty queue tab points at where work comes from', () => {
    expect(emptyQueueCopy('queued')).toContain('inbox')
  })
})

describe('status labels', () => {
  test('blocked reads as needing a person, not as an error', () => {
    expect(statusLabel('blocked')).toBe('needs you')
  })

  test('the rest keep their own name', () => {
    expect(statusLabel('running')).toBe('running')
    expect(statusLabel('failed')).toBe('failed')
  })
})
