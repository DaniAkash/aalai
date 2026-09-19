import { useEffect, useMemo, useState } from 'react'
import { CLAMP_RUN } from '@/screens/run/run.fixture'
import { reduceRun } from '@/screens/run/run.helpers'
import type { RunEvent, RunView } from '@/screens/run/run.types'

export interface RunData {
  readonly view: RunView
  readonly replaying: boolean
  readonly restart: () => void
}

/**
 * The screen's one data hook.
 *
 * Until the service streams events this replays a recorded run, which is also
 * what the fallback recording needs. When the stream lands it replaces the
 * timer here and nothing else in the screen changes, because everything is
 * derived from the same reduction.
 */
export function useRunData(stepMs = 900): RunData {
  const [cursor, setCursor] = useState(0)
  const events: readonly RunEvent[] = useMemo(() => CLAMP_RUN.slice(0, cursor), [cursor])
  const replaying = cursor < CLAMP_RUN.length

  // Advancing a replay is a timer, which is the external-source case a hook
  // like this is for. It is not deriving state from props.
  useEffect(() => {
    if (!replaying) {
      return
    }
    const timer = setTimeout(() => setCursor((c) => c + 1), stepMs)
    return () => clearTimeout(timer)
  }, [cursor, replaying, stepMs])

  return {
    view: useMemo(() => reduceRun(events), [events]),
    replaying,
    restart: () => setCursor(0),
  }
}
