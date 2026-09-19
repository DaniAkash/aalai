import type { RunEvent, RunView, Stage, StationId, StationView } from '@/screens/run/run.types'

const ORDER: readonly Stage[] = ['workspace', 'analyst', 'implementer', 'reviewer', 'deliver']

const LABELS: Record<Stage, string> = {
  workspace: 'workspace',
  analyst: 'analyst',
  implementer: 'implementer',
  commit: 'commit',
  reviewer: 'reviewer',
  deliver: 'deliver',
}

function emptyStation(id: Stage): StationView {
  return { id, label: LABELS[id], state: 'queued', tools: [], notes: [], output: null, handoff: null }
}

const EMPTY: RunView = {
  repo: '',
  issue: 0,
  title: '',
  stations: ORDER.map(emptyStation),
  criteria: [],
  results: [],
  verdict: null,
  prUrl: null,
  stoppedReason: null,
  activeStation: null,
}

/**
 * Folds the event log into what the screen draws.
 *
 * A pure reduction rather than a pile of state, so replaying a run from the
 * ring buffer and following one live produce exactly the same view.
 */
export function reduceRun(events: readonly RunEvent[]): RunView {
  let view = EMPTY

  const patch = (id: Stage, next: Partial<StationView>): void => {
    view = {
      ...view,
      stations: view.stations.map((s) => (s.id === id ? { ...s, ...next } : s)),
    }
  }

  for (const event of events) {
    switch (event.type) {
      case 'run.started':
        view = { ...EMPTY, repo: event.repo, issue: event.issue, title: event.title }
        break

      case 'stage.entered': {
        // Entering a stage settles everything before it.
        const index = ORDER.indexOf(event.stage)
        view = {
          ...view,
          stations: view.stations.map((s, i) =>
            i < index && s.state !== 'done' ? { ...s, state: 'done' } : s,
          ),
        }
        patch(event.stage, { state: 'working' })
        break
      }

      case 'workspace.ready':
        patch('workspace', {
          state: 'done',
          output: event.branch,
          handoff: event.conventions.length === 0 ? 'branch' : `branch, ${event.conventions.join(', ')}`,
        })
        break

      case 'analysis.ready':
        view = { ...view, criteria: event.criteria }
        patch('analyst', {
          state: 'done',
          output: `${event.steps} steps, ${event.criteria.length} criteria`,
          handoff: 'the plan and its criteria',
        })
        break

      case 'agent.tool': {
        const station = view.stations.find((s) => s.id === event.station)
        patch(event.station, { tools: [...(station?.tools ?? []), event.tool] })
        break
      }

      case 'agent.text': {
        const station = view.stations.find((s) => s.id === event.station)
        patch(event.station, { notes: [...(station?.notes ?? []), event.text] })
        break
      }

      case 'commit.made':
        patch('implementer', {
          state: 'done',
          output: event.sha.slice(0, 8),
          handoff: 'a commit, on its own checkout',
        })
        break

      case 'review.verdict':
        view = { ...view, verdict: event.verdict, results: event.results }
        patch('reviewer', {
          state: 'done',
          output: `${event.results.filter((r) => r.pass).length}/${event.results.length}`,
          handoff: 'a verdict, per criterion',
        })
        break

      case 'run.delivered':
        view = { ...view, prUrl: event.prUrl }
        patch('deliver', { state: 'done', output: 'draft pull request' })
        break

      case 'run.stopped':
        view = { ...view, stoppedReason: event.reason }
        view = {
          ...view,
          stations: view.stations.map((s) => (s.state === 'working' ? { ...s, state: 'stopped' } : s)),
        }
        break

      default:
        break
    }
  }

  const working = view.stations.find((s) => s.state === 'working')
  const activeStation =
    working !== undefined && (['analyst', 'implementer', 'reviewer'] as string[]).includes(working.id)
      ? (working.id as StationId)
      : null

  return { ...view, activeStation }
}

/** The verdict for one criterion, or null while it is still unanswered. */
export function resultFor(view: RunView, criterion: string) {
  return view.results.find((r) => r.criterion.trim() === criterion.trim()) ?? null
}
