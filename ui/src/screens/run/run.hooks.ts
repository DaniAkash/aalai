import { useEffect, useState } from 'react'
import type { RunEvent } from '@/screens/run/run.types'

export type StreamStatus = 'connecting' | 'live' | 'offline'

export interface EventStream {
  readonly events: readonly RunEvent[]
  readonly status: StreamStatus
}

/**
 * Subscribes to the service's event stream.
 *
 * An EventSource is exactly the external system a subscription hook is for, and
 * it reconnects on its own. The server replays the current run on connect, so a
 * reconnect mid-run refills rather than resuming from nothing, which is why the
 * events are replaced wholesale on `run.started` instead of appended forever.
 */
export function useEventStream(url = '/api/events'): EventStream {
  const [events, setEvents] = useState<readonly RunEvent[]>([])
  const [status, setStatus] = useState<StreamStatus>('connecting')

  useEffect(() => {
    const source = new EventSource(url)

    source.onopen = () => setStatus('live')
    source.onerror = () => setStatus('offline')
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent | { type: 'heartbeat' }
      if (event.type === 'heartbeat') {
        return
      }
      setEvents((current) => (event.type === 'run.started' ? [event] : [...current, event]))
    }

    return () => source.close()
  }, [url])

  return { events, status }
}
