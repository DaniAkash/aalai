import { useMemo, useState } from 'react'
import { CLAMP_RUN } from '@/screens/run/run.fixture'
import { reduceRun } from '@/screens/run/run.helpers'
import { useEventStream, type StreamStatus } from '@/screens/run/run.hooks'
import type { RunView } from '@/screens/run/run.types'

export interface RunData {
  readonly view: RunView
  readonly status: StreamStatus
  /** True while showing the recorded run because the service has sent nothing. */
  readonly demo: boolean
  readonly toggleDemo: () => void
}

/**
 * The screen's one data hook.
 *
 * Live events when the service has any, and a recorded run otherwise, so the
 * dashboard is never a blank page waiting for something to happen. Both paths
 * feed the same reduction, which is why switching between them changes nothing
 * below this line.
 */
export function useRunData(): RunData {
  const { events, status } = useEventStream()
  const [forceDemo, setForceDemo] = useState(false)

  const demo = forceDemo || events.length === 0
  const source = demo ? CLAMP_RUN : events

  return {
    view: useMemo(() => reduceRun(source), [source]),
    status,
    demo,
    toggleDemo: () => setForceDemo((f) => !f),
  }
}
