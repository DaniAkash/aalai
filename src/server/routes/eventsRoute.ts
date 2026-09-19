import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { latestRunId, replay, subscribe } from '@/events/bus'
import type { RunEvent } from '@/events/events.types'

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
        await stream.writeSSE({ data: JSON.stringify(event), event: event.type })
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
        await stream.writeSSE({ data: '{}', event: 'heartbeat' })
        continue
      }
      const event = queue.shift()
      if (event !== undefined) {
        await stream.writeSSE({ data: JSON.stringify(event), event: event.type })
      }
    }
  }),
)
