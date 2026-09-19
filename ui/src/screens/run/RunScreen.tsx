import { useState } from 'react'
import { cn } from '@/lib/utils'
import { usePastRuns } from '@/modules/api/runs.hooks'
import { useRunData } from '@/screens/run/run.data'
import {
  ActivityPanel,
  CriteriaPanel,
  History,
  Outcome,
  Refusals,
  StationLine,
} from '@/screens/run/run.components'

/** Survives a reload, because a projector is a bad place to rediscover a toggle. */
const PRESENT_KEY = 'aalai:present'

export function RunScreen() {
  const { view, status, demo, toggleDemo } = useRunData()
  const [present, setPresent] = useState(
    () => globalThis.localStorage?.getItem(PRESENT_KEY) === '1',
  )
  const [showHistory, setShowHistory] = useState(false)
  const history = usePastRuns({ enabled: showHistory })

  const togglePresent = (): void => {
    setPresent((current) => {
      globalThis.localStorage?.setItem(PRESENT_KEY, current ? '0' : '1')
      return !current
    })
  }

  return (
    <main
      className={cn(
        'stage flex h-svh flex-col gap-10 overflow-hidden bg-void px-[4vw] py-[4vh] text-bone',
        // Presentation mode is the same layout at a size that reads from the
        // back of a room, with the activity column dropped so one idea is on
        // screen rather than two.
        present && 'text-[1.35em] gap-12',
      )}
    >
      <header className="flex shrink-0 items-baseline justify-between gap-8">
        <div className="flex min-w-0 flex-col gap-2">
          <span className="font-mono text-[0.62em] uppercase tracking-[0.2em] text-ash">
            aalai
            {view.repo !== '' && <span className="ml-4 text-ash/70">{view.repo}</span>}
            {view.issue !== 0 && <span className="ml-3 text-ash/70">issue {view.issue}</span>}
          </span>
          <h1 className="max-w-[24ch] text-[1.6em] leading-tight">
            {view.title === '' ? 'Waiting for work' : view.title}
          </h1>
        </div>

        <nav className="flex shrink-0 items-center gap-3">
          <Toggle active={showHistory} onClick={() => setShowHistory((s) => !s)}>
            history
          </Toggle>
          <Toggle active={present} onClick={togglePresent}>
            present
          </Toggle>
          <Toggle active={!demo} onClick={toggleDemo}>
            {demo ? 'recorded' : 'live'}
            <span className={status === 'offline' ? 'ml-2 text-spark' : 'ml-2 text-iris'}>
              {status === 'live' ? '·' : status === 'offline' ? '!' : '…'}
            </span>
          </Toggle>
        </nav>
      </header>

      <StationLine view={view} />

      {showHistory ? (
        <section className="min-h-0 flex-1 overflow-y-auto">
          <History runs={history.data ?? []} loading={history.isPending} />
        </section>
      ) : (
        <section
          className={cn(
            'grid min-h-0 flex-1 grid-cols-1 gap-16 overflow-hidden [&>*]:min-h-0 [&>*]:min-w-0 [&>*]:overflow-y-auto',
            present ? 'lg:grid-cols-1' : 'lg:grid-cols-[1.1fr_0.9fr]',
          )}
        >
          <CriteriaPanel view={view} />
          {!present && <ActivityPanel view={view} />}
        </section>
      )}

      <footer className="flex shrink-0 flex-col gap-4">
        <Refusals view={view} />
        <Outcome view={view} />
      </footer>
    </main>
  )
}

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-5 py-2 font-mono text-[0.6em] uppercase tracking-[0.2em] transition-colors',
        active
          ? 'border-iris text-bone'
          : 'border-hairline text-ash hover:border-ash hover:text-bone',
      )}
    >
      {children}
    </button>
  )
}
