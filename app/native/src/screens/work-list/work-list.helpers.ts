import type { Lane } from 'aalai/shared'

/** The filters across the top, and which lanes each one keeps. */
export const FILTERS = [
  { key: 'all', label: 'All', lanes: null },
  { key: 'needsyou', label: 'Needs you', lanes: ['needsyou'] },
  { key: 'running', label: 'Running', lanes: ['running'] },
  { key: 'waiting', label: 'Waiting', lanes: ['queued', 'offered'] },
  { key: 'done', label: 'Done', lanes: ['done'] },
  { key: 'failed', label: 'Needs another look', lanes: ['failed'] },
] as const satisfies readonly {
  key: string
  label: string
  lanes: readonly Lane[] | null
}[]

export type FilterKey = (typeof FILTERS)[number]['key']

export function lanesFor(key: FilterKey): readonly Lane[] | null {
  return FILTERS.find((filter) => filter.key === key)?.lanes ?? null
}

export function countFor(
  key: FilterKey,
  counts: Record<string, number>,
  total: number,
): number {
  const lanes = lanesFor(key)
  if (lanes === null) {
    return total
  }
  return lanes.reduce((sum, lane) => sum + (counts[lane] ?? 0), 0)
}

/**
 * How long ago, in the roughest unit that is still true.
 *
 * A run that started four minutes ago is "4 min ago" and never "4 minutes and
 * 12 seconds". The precision a list needs is whether this is recent, and a
 * second hand ticking in a row a person is trying to read is noise.
 */
export function since(iso: string | null): string {
  if (iso === null) {
    return ''
  }
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) {
    return ''
  }
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) {
    return 'just now'
  }
  if (mins < 60) {
    return `${mins} min ago`
  }
  const hours = Math.floor(mins / 60)
  if (hours < 24) {
    return `${hours} h ago`
  }
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/** The initial shown in a row's avatar, for whoever holds the work. */
export function stationInitial(station: string | null): string {
  if (station === null) {
    return ''
  }
  const first = station.charAt(0)
  return first === '' ? '' : first.toUpperCase()
}
