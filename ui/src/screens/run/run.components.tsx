import { CheckIcon, WarningIcon } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { resultFor } from '@/screens/run/run.helpers'
import type { RunView, StationView } from '@/screens/run/run.types'

/**
 * One station on the line.
 *
 * The rule across the top carries the state, so the eye reads four identical
 * shapes and learns one vocabulary: dashed is queued, solid violet is working,
 * thin white is done. No dots, no badges, no spinner.
 */
export function Station({ station }: { station: StationView }) {
  const { state } = station
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <div
        className={cn(
          'h-px w-full transition-colors duration-300',
          state === 'queued' && 'border-t border-dashed border-hairline bg-transparent',
          state === 'working' && 'h-[3px] bg-iris',
          state === 'done' && 'bg-bone/40',
          state === 'stopped' && 'h-[3px] bg-spark',
        )}
      />
      <div className="flex flex-col gap-1">
        <span
          className={cn(
            'font-mono tracking-wide transition-colors duration-300',
            state === 'working' ? 'text-bone uppercase' : 'text-ash',
          )}
        >
          {station.label}
        </span>
        <span className="text-[0.8em] text-ash">
          {state === 'queued' && 'queued'}
          {state === 'working' && (station.tools.at(-1) ?? 'working')}
          {state === 'done' && (station.output ?? 'done')}
          {state === 'stopped' && 'stopped'}
        </span>
      </div>
    </div>
  )
}

/** The line, with the handoff named under each arrow. That is what makes it a line. */
export function StationLine({ view }: { view: RunView }) {
  return (
    <div className="flex w-full items-start gap-4">
      {view.stations.map((station, index) => (
        <div key={station.id} className="flex min-w-0 flex-1 items-start gap-4">
          <Station station={station} />
          {index < view.stations.length - 1 && (
            <div className="flex w-28 shrink-0 flex-col items-center gap-3 pt-0">
              <div className="h-px w-full bg-hairline" />
              <span className="text-center text-[0.62em] leading-tight text-ash/70">
                {station.handoff ?? ''}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * The criteria, from the moment the analyst writes them to the moment the
 * reviewer answers them.
 *
 * This is the only element that persists across three stations, and that
 * persistence is the argument: written before the code, answered against the
 * diff, one row at a time.
 */
export function CriteriaPanel({ view }: { view: RunView }) {
  if (view.criteria.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <PanelLabel>acceptance criteria</PanelLabel>
        <p className="text-[0.85em] text-ash">
          The planning station has not written them yet.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PanelLabel>
        acceptance criteria
        <span className="ml-3 normal-case tracking-normal text-ash/70">
          {view.results.length === 0 ? 'written before any code' : 'judged against the diff'}
        </span>
      </PanelLabel>

      <ul className="flex flex-col gap-4">
        {view.criteria.map((criterion) => {
          const result = resultFor(view, criterion)
          return (
            <li key={criterion} className="flex gap-3">
              <span className="mt-[0.35em] w-5 shrink-0">
                {result === null && <span className="text-ash">·</span>}
                {result?.pass === true && <CheckIcon weight="bold" className="text-iris" />}
                {result?.pass === false && <WarningIcon weight="bold" className="text-spark" />}
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <span
                  className={cn(
                    'transition-colors duration-500',
                    result === null ? 'text-ash' : result.pass ? 'text-bone' : 'text-spark',
                  )}
                >
                  {criterion}
                </span>
                {result !== null && (
                  <span className="text-[0.75em] leading-snug text-ash">{result.evidence}</span>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** What the working station is doing right now. Tool calls as a list, text as settled paragraphs. */
export function ActivityPanel({ view }: { view: RunView }) {
  const active = view.stations.find((s) => s.state === 'working')
  const station = active ?? [...view.stations].reverse().find((s) => s.notes.length > 0)

  if (station === undefined) {
    return null
  }

  return (
    <div className="flex flex-col gap-5">
      <PanelLabel>{station.label}</PanelLabel>

      {station.tools.length > 0 && (
        <ul className="flex flex-col gap-1 font-mono text-[0.72em] text-ash">
          {station.tools.slice(-6).map((tool, i) => (
            <li key={`${tool}-${i}`} className="truncate">
              <span className="text-iris">▌</span> {tool}
            </li>
          ))}
        </ul>
      )}

      {station.notes.length > 0 && (
        <p className="max-w-[46ch] text-[0.85em] leading-relaxed text-mist">
          {station.notes.at(-1)}
        </p>
      )}
    </div>
  )
}

export function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[0.62em] uppercase tracking-[0.2em] text-spark">
      {children}
    </span>
  )
}

/** The run's outcome, once there is one. */
export function Outcome({ view }: { view: RunView }) {
  if (view.prUrl !== null) {
    return (
      <div className="flex items-baseline gap-4">
        <span className="font-mono text-[0.62em] uppercase tracking-[0.2em] text-ash">
          delivered
        </span>
        <a
          href={view.prUrl}
          target="_blank"
          rel="noreferrer"
          className="text-iris underline-offset-4 hover:underline"
        >
          {view.prUrl.replace('https://github.com/', '')}
        </a>
        <span className="text-[0.75em] text-ash">draft, a person marks it ready</span>
      </div>
    )
  }
  if (view.stoppedReason !== null) {
    return (
      <div className="flex items-baseline gap-4">
        <span className="font-mono text-[0.62em] uppercase tracking-[0.2em] text-spark">
          stopped
        </span>
        <span className="text-mist">{view.stoppedReason}</span>
      </div>
    )
  }
  return null
}
