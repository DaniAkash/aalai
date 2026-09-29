import { useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { recentlyAnnouncedGate } from '@/modules/notify/notify'

/**
 * Takes the window to the gate a notification was probably about.
 *
 * **This is an approximation, and it is worth knowing why rather than being
 * surprised by it.** Tauri's notification actions are mobile only, so a click on
 * a desktop notification carries no payload: nothing tells the app which
 * notification it was. What a click does do is bring the app forward, so this
 * listens for that and routes to the gate most recently announced.
 *
 * It is therefore wrong when two gates open within seconds of each other and the
 * person clicks the older one. Getting it exactly right needs a native
 * `UNUserNotificationCenter` delegate that reports which notification was
 * activated, which belongs with the rest of the native tray work rather than
 * here.
 *
 * It deliberately does nothing when the window was already visible: a person
 * switching back to a window they left open did not ask to be moved, and moving
 * them would lose whatever they were reading.
 */
export function useGateOnActivation(): void {
  const navigate = useNavigate()

  // Subscribing to a document event, which is an external source and cannot be
  // expressed as a render or a handler.
  useEffect(() => {
    let wasHidden = document.visibilityState === 'hidden'

    const onVisibility = (): void => {
      const hidden = document.visibilityState === 'hidden'
      const cameBack = wasHidden && !hidden
      wasHidden = hidden
      if (!cameBack) {
        return
      }
      const gateId = recentlyAnnouncedGate()
      if (gateId === undefined) {
        return
      }
      void navigate({ to: '/gates/$gateId', params: { gateId } })
    }

    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [navigate])
}
