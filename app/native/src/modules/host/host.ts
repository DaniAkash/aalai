import { isTauri } from '@tauri-apps/api/core'

/**
 * Which shell the interface is running in.
 *
 * The app is a Tauri window and a plain web page, and neither is the fallback
 * for the other. `isTauri()` reads a global the runtime installs, so it is
 * safe to call in a browser where no Tauri anything exists.
 */
export function isDesktop(): boolean {
  return isTauri()
}
