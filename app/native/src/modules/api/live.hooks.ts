import type { RunEvent } from 'aalai-core/events'
import { useEffect, useState } from 'react'
import { type StreamState, subscribeToRunEvents } from '@/modules/api/events'
import { useGate, useOpenGates } from '@/modules/api/gates.hooks'
import { queryClient } from '@/modules/api/queryClient'
import { useActiveRuns, usePastRuns } from '@/modules/api/runs.hooks'

/**
 * Keeps the cache honest while the factory works.
 *
 * A push channel that invalidates rather than a store the screens read. That
 * keeps one source of truth, the query cache, so a dropped connection degrades
 * to stale data instead of to a screen showing something the factory never
 * said.
 */
export function useLiveEvents(): StreamState {
  const [state, setState] = useState<StreamState>('connecting')

  // The one legitimate effect here: subscribing to an event source outside
  // React, which cannot be expressed as a render or an event handler.
  useEffect(() => {
    const controller = new AbortController()
    void subscribeToRunEvents({
      signal: controller.signal,
      onState: setState,
      onEvent: invalidateFor,
    })
    return () => controller.abort()
  }, [])

  return state
}

/** What each event means for the cache, and nothing else. */
function invalidateFor(event: RunEvent): void {
  if (event.type === 'gate.opened' || event.type === 'gate.answered') {
    void queryClient.invalidateQueries({ queryKey: useOpenGates.getKey() })
    void queryClient.invalidateQueries({
      queryKey: useGate.getKey({ id: event.gateId }),
    })
    return
  }
  // Everything else moves a run. Both lists, because the row comes from the
  // history and the link to its detail comes from what is still in memory: a
  // row whose events arrived but whose lookup did not has nowhere to go.
  void queryClient.invalidateQueries({ queryKey: usePastRuns.getKey() })
  void queryClient.invalidateQueries({ queryKey: useActiveRuns.getKey() })
}
