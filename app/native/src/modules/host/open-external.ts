import { openUrl } from '@tauri-apps/plugin-opener'
import { isDesktop } from './host'

/**
 * Opens a link outside the interface, in whichever way this host can.
 *
 * Not a `TauriOnly` case: opening a pull request is something both hosts can
 * genuinely do, so it degrades to the browser's own behaviour rather than
 * disappearing. A boundary would not help here anyway, because this is called
 * from an event handler and React only catches what throws during render.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isDesktop()) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  await openUrl(url)
}
