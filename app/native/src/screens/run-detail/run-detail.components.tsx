import type { RunEvent } from 'aalai/events'
import { STATIONS, type StationState } from './run-detail.helpers'

const MARK: Record<StationState, string> = {
  waiting: 'border-border text-muted-foreground',
  working: 'border-chart-4 text-foreground',
  done: 'border-chart-2 text-foreground',
}

/**
 * The belt: which station has the work.
 *
 * Horizontal because a run is a sequence, and the question a person arrives
 * with is "where is it", which a row answers at a glance and a list does not.
 */
export function Belt({ states }: { states: Record<string, StationState> }) {
  return (
    <ol className="mb-5 flex items-center gap-2">
      {STATIONS.map((station, index) => (
        <li key={station} className="flex items-center gap-2">
          <span
            className={`rounded-full border px-2.5 py-1 font-mono text-[11px] ${MARK[states[station] ?? 'waiting']}`}
          >
            {station}
            {states[station] === 'working' ? ' …' : ''}
          </span>
          {index < STATIONS.length - 1 ? (
            <span className="text-muted-foreground">·</span>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

/**
 * The acceptance criteria, and the reviewer's answer to each.
 *
 * These are the contract the implementer is graded against, so they persist
 * from the moment the analyst writes them rather than appearing with the
 * verdict.
 */
export function Criteria({
  criteria,
  results,
}: {
  criteria: readonly string[]
  results: readonly { criterion: string; pass: boolean; evidence: string }[]
}) {
  if (criteria.length === 0) {
    return null
  }
  return (
    <ul className="mb-5 rounded-xl border border-border bg-card px-4">
      {criteria.map((criterion) => {
        const result = results.find((row) => row.criterion === criterion)
        return (
          <li
            key={criterion}
            className="flex gap-3 border-border border-b py-2.5 last:border-b-0"
          >
            <span
              className={
                result === undefined
                  ? 'text-muted-foreground'
                  : result.pass
                    ? 'text-chart-2'
                    : 'text-destructive'
              }
            >
              {result === undefined ? '·' : result.pass ? '✓' : '✕'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px]">{criterion}</div>
              {result === undefined || result.evidence === '' ? null : (
                <div className="text-[12px] text-muted-foreground">
                  {result.evidence}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** Everything the run said, for when the summary is not enough. */
export function EventLog({ events }: { events: readonly RunEvent[] }) {
  return (
    <ol className="rounded-xl border border-border bg-card px-4">
      {events.map((event, index) => (
        <li
          // A run's log is append only and never reordered or filtered, and
          // events carry no id of their own: two emitted in the same
          // millisecond are distinguishable only by position.
          // biome-ignore lint/suspicious/noArrayIndexKey: the list only grows
          key={index}
          className="flex gap-3 border-border border-b py-2 font-mono text-[11.5px] last:border-b-0"
        >
          <span className="shrink-0 text-muted-foreground">
            {new Date(event.at).toLocaleTimeString()}
          </span>
          <span className="shrink-0 text-muted-foreground">{event.type}</span>
          <span className="min-w-0 flex-1 truncate">{detail(event)}</span>
        </li>
      ))}
    </ol>
  )
}

function detail(event: RunEvent): string {
  switch (event.type) {
    case 'stage.entered':
      return event.stage
    case 'agent.tool':
      return `${event.station} called ${event.tool}`
    case 'agent.text':
      return event.text.slice(0, 120)
    case 'commit.made':
      return event.sha.slice(0, 10)
    case 'review.verdict':
      return event.verdict
    case 'run.delivered':
      return event.prUrl
    case 'run.failed':
      return event.error
    case 'run.stopped':
      return event.reason
    case 'gate.opened':
      return `${event.kind} gate`
    case 'gate.answered':
      return `${event.decision} from the ${event.answeredOn}`
    default:
      return ''
  }
}
