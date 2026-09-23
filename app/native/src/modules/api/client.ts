import { invoke } from '@tauri-apps/api/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { hc } from 'hono/client'
import type { AppType } from 'aalai-core/app'

interface ApiInfo {
  port: number | null
  token: string
}

let cached: ApiInfo | null = null

/**
 * Where the factory is listening.
 *
 * Neither value can be known ahead of time: the port is chosen by the OS when
 * the sidecar binds, and the token is fresh for each launch.
 */
async function info(): Promise<ApiInfo> {
  if (cached?.port) return cached
  cached = await invoke<ApiInfo>('api_info')
  return cached
}

/**
 * The typed client, over Tauri's HTTP plugin rather than the webview's fetch.
 *
 * The webview origin is never same origin with 127.0.0.1, so browser fetch
 * would need permissive CORS on a server that can open pull requests. Going
 * through Rust avoids needing any.
 */
export async function api() {
  const { port, token } = await info()
  if (!port) throw new Error('the factory has not reported a port yet')
  return hc<AppType>(`http://127.0.0.1:${port}`, {
    fetch: tauriFetch as unknown as typeof fetch,
    headers: { authorization: `Bearer ${token}` },
  })
}

/** Where the event stream lives, for the pieces that subscribe rather than query. */
export async function eventsUrl(): Promise<string> {
  const { port } = await info()
  return `http://127.0.0.1:${port}/api/events`
}
