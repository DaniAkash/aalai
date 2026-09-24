import { invoke } from '@tauri-apps/api/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { type Client, hcWithType } from 'aalai-core/client'
import { isDesktop } from '@/modules/host/host'

interface ApiInfo {
  port: number | null
  token: string
}

let desktop: ApiInfo | null = null
let web: Client | null = null

/**
 * Where the factory is listening, asked of the shell that spawned it.
 *
 * Neither value can be known ahead of time: the port is chosen by the OS when
 * the sidecar binds, and the token is fresh for each launch.
 */
async function desktopInfo(): Promise<ApiInfo> {
  if (desktop?.port) {
    return desktop
  }
  desktop = await invoke<ApiInfo>('api_info')
  return desktop
}

/**
 * The typed client, over whichever transport this host has.
 *
 * The two differ in more than a base URL, which is why this branches rather
 * than parameterising one path:
 *
 * In the desktop window the webview origin is never same origin with
 * 127.0.0.1, so a browser fetch would need permissive CORS on a server that
 * can open pull requests. Going through Rust avoids needing any, and the port
 * and the per launch token come from the shell that spawned the sidecar.
 *
 * On the web the page is served by Vite, which proxies `/api` to the factory.
 * Requests are same origin, so nothing needs CORS and nothing needs a port:
 * the proxy holds the address, and the token if there is one, so a secret is
 * never handed to a browser.
 */
export async function api(): Promise<Client> {
  if (!isDesktop()) {
    web ??= hcWithType('')
    return web
  }
  const { port, token } = await desktopInfo()
  if (!port) {
    throw new Error('the factory has not reported a port yet')
  }
  return hcWithType(`http://127.0.0.1:${port}`, {
    fetch: tauriFetch as unknown as typeof fetch,
    headers: { authorization: `Bearer ${token}` },
  })
}
