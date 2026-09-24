import type { RunEvent } from 'aalai-core/events'
import { api } from '@/modules/api/client'

/** What the stream sends that is not a run event. */
type Frame = RunEvent | { readonly type: 'stream.open' | 'heartbeat' }

export type StreamState = 'connecting' | 'live' | 'lost'

export interface Subscription {
  readonly onEvent: (event: RunEvent) => void
  readonly onState: (state: StreamState) => void
  readonly signal: AbortSignal
}

/** Backoff between reconnects, so a factory that is down is not hammered. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000] as const

/**
 * The factory's event stream, read as a stream.
 *
 * Hono's guide has no section on consuming a streamed response through the RPC
 * client, so this is the one place that knows the shape: the typed client for
 * the request, a reader for the body, and a frame parser here rather than
 * scattered through the screens.
 *
 * `EventSource` is not an option. It cannot carry the bearer header every route
 * but health requires, and the desktop build reaches the factory through Rust
 * rather than the webview's own fetch.
 */
export async function subscribeToRunEvents(
  subscription: Subscription,
): Promise<void> {
  let attempt = 0
  while (!subscription.signal.aborted) {
    try {
      subscription.onState('connecting')
      await readStream(subscription)
      // A stream that ends without an error is the factory going away, which
      // is a reconnect rather than a failure.
      attempt = 0
    } catch {
      // Losing the factory is expected: it restarts, the machine sleeps. The
      // screens say so rather than showing a dead page.
    }
    if (subscription.signal.aborted) {
      return
    }
    subscription.onState('lost')
    await sleep(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 10_000)
    attempt += 1
  }
}

async function readStream(subscription: Subscription): Promise<void> {
  const client = await api()
  const response = await client.api.events.$get(
    {},
    { init: { signal: subscription.signal } },
  )
  const body = response.body
  if (!response.ok || body === null) {
    throw new Error(`the event stream refused: ${response.status}`)
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!subscription.signal.aborted) {
      const { done, value } = await reader.read()
      if (done) {
        return
      }
      buffer += decoder.decode(value, { stream: true })
      // Frames are separated by a blank line; anything after the last one is a
      // partial frame and waits for the next chunk.
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const event = parseFrame(frame)
        if (event === undefined) {
          continue
        }
        // Anything arriving at all means the connection is live, including
        // the frames that carry no news.
        subscription.onState('live')
        if (isRunEvent(event)) {
          subscription.onEvent(event)
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

function isRunEvent(frame: Frame): frame is RunEvent {
  return frame.type !== 'stream.open' && frame.type !== 'heartbeat'
}

function parseFrame(frame: string): Frame | undefined {
  const data = frame
    .split('\n')
    .find((line) => line.startsWith('data:'))
    ?.slice('data:'.length)
    .trim()
  if (data === undefined || data === '') {
    return undefined
  }
  try {
    return JSON.parse(data) as Frame
  } catch {
    // A malformed frame is not worth taking the stream down for.
    return undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
