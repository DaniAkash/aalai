import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { SSEStreamingApi } from 'hono/streaming'
import { latestRunId, replay, subscribe } from '@/events/bus'
import type { RunEvent } from '@/events/events.types'

/**
 * Sends an event with no SSE `event:` name.
 *
 * A named SSE event is only delivered to a listener registered for that exact
 * name, never to `onmessage`, so naming them meant a browser received nothing
 * at all while reporting a healthy connection. The payload already carries its
 * own `type`, which also means a new event type cannot go silently undelivered.
 */
async function send(stream: SSEStreamingApi, event: RunEvent): Promise<void> {
  await stream.writeSSE({ data: JSON.stringify(event) })
}

/**
 * The live stream.
 *
 * A subscriber is replayed the current run before it receives anything new, so
 * opening the dashboard halfway through a run shows the run so far rather than
 * an empty screen. That is the property that makes this usable on stage, where
 * the browser is often opened after the run has already started.
 */
export const eventsRoute = new Hono().get('/events', (c) =>
  streamSSE(c, async (stream) => {
    const queue: RunEvent[] = []
    let notify: (() => void) | null = null

    const unsubscribe = subscribe((event) => {
      queue.push(event)
      notify?.()
    })
    stream.onAbort(unsubscribe)

    const runId = latestRunId()
    if (runId !== null) {
      for (const event of replay(runId)) {
        await send(stream, event)
      }
    }

    // Held open until the client goes away. A heartbeat keeps proxies and
    // sleeping laptops from quietly dropping the connection mid-demo.
    while (!stream.aborted) {
      if (queue.length === 0) {
        await Promise.race([
          new Promise<void>((resolve) => {
            notify = resolve
          }),
          stream.sleep(15_000),
        ])
        notify = null
      }
      if (queue.length === 0) {
        await stream.writeSSE({ data: JSON.stringify({ type: 'heartbeat' }) })
        continue
      }
      const event = queue.shift()
      if (event !== undefined) {
        await send(stream, event)
      }
    }
  }),
)
