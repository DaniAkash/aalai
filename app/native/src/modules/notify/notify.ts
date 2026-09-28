import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { isDesktop } from '@/modules/host/host'

/**
 * Telling someone a gate opened, from whichever shell the interface is in.
 *
 * Fired here rather than from Rust because the window closing hides the webview
 * instead of destroying it, so the event subscription this rides on is still
 * running with nothing on screen. It also keeps the event stream a Hono concern
 * rather than growing a second copy of it in the shell.
 *
 * Every failure is swallowed. A notification that cannot be shown is a smaller
 * problem than an interface that breaks because it could not show one, and the
 * gate is still in the inbox either way.
 */

/**
 * Gates already announced, for the life of this process.
 *
 * Keyed on the gate rather than the event, because a run passes through several
 * stations and announcing per station is how people end up turning notifications
 * off. One gate, one notification.
 */
const announced = new Set<string>()

/**
 * The gate most recently announced, and when.
 *
 * Desktop notification actions are mobile only in Tauri, so a click carries no
 * payload and cannot say which gate it was about. Clicking does bring the app
 * forward, so this is what the interface routes to when it does. It is an
 * approximation, and it is wrong when two gates open seconds apart: the exact
 * version needs a native notification delegate, which belongs with the rest of
 * the native tray work.
 */
let lastAnnounced: { gateId: string; at: number } | undefined

/** The gate a click most plausibly meant, if it is recent enough to guess. */
export function recentlyAnnouncedGate(
  withinMs = 5 * 60_000,
): string | undefined {
  if (lastAnnounced === undefined) {
    return undefined
  }
  return Date.now() - lastAnnounced.at < withinMs
    ? lastAnnounced.gateId
    : undefined
}

async function allowed(): Promise<boolean> {
  if (isDesktop()) {
    return (
      (await isPermissionGranted()) || (await requestPermission()) === 'granted'
    )
  }
  if (typeof Notification === 'undefined') {
    return false
  }
  if (Notification.permission === 'granted') {
    return true
  }
  if (Notification.permission === 'denied') {
    return false
  }
  return (await Notification.requestPermission()) === 'granted'
}

export interface GateOpened {
  readonly gateId: string
  readonly repo: string
  readonly issue: number
  readonly summary?: string | undefined
}

export async function announceGate(gate: GateOpened): Promise<boolean> {
  if (announced.has(gate.gateId)) {
    return false
  }
  announced.add(gate.gateId)
  lastAnnounced = { gateId: gate.gateId, at: Date.now() }

  const title = `${gate.repo}#${gate.issue}`
  const body = gate.summary ?? 'A plan is waiting for your approval.'
  try {
    if (!(await allowed())) {
      return false
    }
    if (isDesktop()) {
      sendNotification({ title, body })
    } else {
      new Notification(title, { body, tag: gate.gateId })
    }
    return true
  } catch {
    return false
  }
}

/** Only for tests: the set is process scoped and would otherwise leak between them. */
export function forgetAnnounced(): void {
  announced.clear()
  lastAnnounced = undefined
}
