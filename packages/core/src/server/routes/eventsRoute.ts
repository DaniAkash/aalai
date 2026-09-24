import { Hono } from 'hono'
import type { SSEStreamingApi } from 'hono/streaming'
import { streamSSE } from 'hono/streaming'
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

    // Written before anything else, because a streamed response sends no
    // headers until its first write. An idle factory would otherwise leave a
    // client with an unresolved request for a full heartbeat interval, unable
    // to tell a quiet connection from an unreachable one.
    await stream.writeSSE({ data: JSON.stringify({ type: 'stream.open' }) })

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
        await waitForEvent(stream, (resolve) => {
          notify = resolve
        })
        notify = null
      }
      const event = queue.shift()
      if (event === undefined) {
        await stream.writeSSE({ data: JSON.stringify({ type: 'heartbeat' }) })
        continue
      }
      await send(stream, event)
    }
  }),
)

/**
 * Waits for the next event, or for the heartbeat interval, whichever lands
 * first. Split out so the stream loop above stays one readable shape.
 */
function waitForEvent(
  stream: SSEStreamingApi,
  arm: (resolve: () => void) => void,
): Promise<unknown> {
  return Promise.race([new Promise<void>(arm), stream.sleep(15_000)])
}
