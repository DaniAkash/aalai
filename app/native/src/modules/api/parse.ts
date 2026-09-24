/** The part of a response we actually use, so Hono's client type fits too. */
export interface Readable {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  text(): Promise<string>
  json(): Promise<unknown>
}

/**
 * Reads a response, or throws with something a person can act on.
 *
 * Every fetcher goes through here so no call site reads `.json()` directly and
 * quietly treats a 401 as data.
 */
export async function parseResponse<T>(response: Readable): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`,
    )
  }
  return (await response.json()) as T
}
