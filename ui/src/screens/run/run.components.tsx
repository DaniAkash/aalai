import { CheckIcon, WarningIcon } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { resultFor } from '@/screens/run/run.helpers'
import type { PastRun, RunView, StationView } from '@/screens/run/run.types'

/**
 * One station on the line.
 *
 * The rule across the top carries the state, so the eye reads four identical
 * shapes and learns one vocabulary: dashed is queued, solid violet is working,
 * thin white is done. No dots, no badges, no spinner.
 */
/** The first line of a command, for a place that has room for exactly one. */
function firstLine(text: string): string {
  return text.split('\n')[0] ?? text
}

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
        <span className="truncate text-[0.8em] text-ash" title={station.tools.at(-1) ?? ''}>
          {state === 'queued' && 'queued'}
          {/* One line. A real tool call is a multi-line shell pipeline, and
              letting it wrap blows the station out and unbalances the line. */}
          {state === 'working' && firstLine(station.tools.at(-1) ?? 'working')}
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
      <div className="flex min-w-0 flex-col gap-3">
        <PanelLabel>acceptance criteria</PanelLabel>
        <p className="text-[0.85em] text-ash">
          The planning station has not written them yet.
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
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
    <div className="flex min-w-0 flex-col gap-5">
      <PanelLabel>{station.label}</PanelLabel>

      {station.tools.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-1 font-mono text-[0.72em] text-ash">
          {station.tools.slice(-6).map((tool, i) => (
            <li key={`${tool}-${i}`} className="truncate" title={tool}>
              <span className="text-iris">▌</span> {firstLine(tool)}
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

/** Issues the gate turned away, so a refusal is visible rather than buried in a log. */
export function Refusals({ view }: { view: RunView }) {
  if (view.refusals.length === 0) {
    return null
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PanelLabel>turned away at the door</PanelLabel>
      <ul className="flex flex-col gap-2">
        {view.refusals.map((refusal) => (
          <li key={`${refusal.repo}#${refusal.issue}@${refusal.at}`} className="flex gap-3">
            <span className="shrink-0 font-mono text-[0.72em] text-ash">
              {refusal.repo.split('/').at(-1)}#{refusal.issue}
            </span>
            <span className="min-w-0 truncate text-[0.8em] text-spark" title={refusal.reason}>
              {refusal.reason}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Finished runs and what they produced. */
export function History({ runs, loading }: { runs: readonly PastRun[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <PanelLabel>recent runs</PanelLabel>
        <ul className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-5 w-2/3 animate-pulse rounded bg-hairline" />
          ))}
        </ul>
      </div>
    )
  }

  if (runs.length === 0) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <PanelLabel>recent runs</PanelLabel>
        <p className="text-[0.85em] text-ash">
          Nothing yet. Label an issue or hand one over directly, and it appears here.
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PanelLabel>recent runs</PanelLabel>
      <ul className="flex flex-col gap-4">
        {runs.map((run) => (
          <li key={`${run.repo}#${run.issue}`} className="flex min-w-0 items-baseline gap-4">
            <span className="w-14 shrink-0 font-mono text-[0.72em] text-ash">#{run.issue}</span>
            <span
              className={cn(
                'w-24 shrink-0 font-mono text-[0.68em] uppercase tracking-wide',
                run.status === 'delivered' && 'text-iris',
                run.status === 'failed' && 'text-spark',
                run.status !== 'delivered' && run.status !== 'failed' && 'text-ash',
              )}
            >
              {run.status}
            </span>
            {run.pr_url === null ? (
              <span className="min-w-0 truncate text-[0.8em] text-ash">
                {run.error ?? 'no pull request'}
              </span>
            ) : (
              <a
                href={run.pr_url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate text-[0.8em] text-mist underline-offset-4 hover:text-bone hover:underline"
              >
                {run.pr_url.replace('https://github.com/', '')}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
