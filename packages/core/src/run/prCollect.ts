import type { Signal } from '@/run/prSignals'

/**
 * Gathering signals into one revision rather than racing several.
 *
 * The common real case is a reviewer commenting while a check is failing, and
 * the wrong answer is two revisions against the same branch: they would both
 * start from the same commit, both push, and the second would undo the first.
 *
 * So a window opens on the first signal and everything arriving inside it joins
 * the same revision. The window is a timestamp rather than a timer because a
 * run that restarts mid window must not wait again from the beginning, and
 * because a timer does not survive the process that owns it.
 */

/** How long to let signals gather before acting on them. */
const WINDOW_MS = 90_000

export interface Collecting {
  /** When the first signal of this batch arrived. */
  readonly openedAt: string
  readonly signals: readonly Signal[]
}

export function open(at: string, signal: Signal): Collecting {
  return { openedAt: at, signals: [signal] }
}

export function add(batch: Collecting, signal: Signal): Collecting {
  return { ...batch, signals: [...batch.signals, signal] }
}

/** Whether the window has been open long enough to act on what is in it. */
export function ready(
  batch: Collecting,
  now: number,
  windowMs = WINDOW_MS,
): boolean {
  return now - Date.parse(batch.openedAt) >= windowMs
}

/**
 * What a batch amounts to, once it stops gathering.
 *
 * The order is the order of consequence rather than of arrival. A branch
 * somebody else touched stops everything, because every other answer is a push.
 * A moved base is next, because revising against the old one produces a diff
 * that will not apply. Then the work itself.
 */
export type Upshot =
  | { readonly kind: 'stop'; readonly author: string }
  | { readonly kind: 'rebase'; readonly baseSha: string }
  | {
      readonly kind: 'revise'
      readonly failing: readonly string[]
      readonly asked: readonly Signal[]
    }
  | { readonly kind: 'nothing' }

export function upshotOf(batch: Collecting): Upshot {
  const touched = batch.signals.find((s) => s.kind === 'branch_touched')
  if (touched !== undefined && touched.kind === 'branch_touched') {
    return { kind: 'stop', author: touched.author }
  }
  const moved = batch.signals.find((s) => s.kind === 'base_moved')
  if (moved !== undefined && moved.kind === 'base_moved') {
    return { kind: 'rebase', baseSha: moved.baseSha }
  }
  const failing = batch.signals
    .filter((s) => s.kind === 'checks_failed')
    .flatMap((s) => (s.kind === 'checks_failed' ? s.names : []))
  const asked = batch.signals.filter((s) => s.kind === 'comments')
  if (failing.length === 0 && asked.length === 0) {
    return { kind: 'nothing' }
  }
  return { kind: 'revise', failing, asked }
}
