import { useRunData } from '@/screens/run/run.data'
import {
  ActivityPanel,
  CriteriaPanel,
  Outcome,
  StationLine,
} from '@/screens/run/run.components'

export function RunScreen() {
  const { view, status, demo, toggleDemo } = useRunData()

  return (
    <main className="stage flex h-svh flex-col gap-10 overflow-hidden bg-void px-[4vw] py-[4vh] text-bone">
      <header className="flex shrink-0 items-baseline justify-between gap-8">
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[0.62em] uppercase tracking-[0.2em] text-ash">
            aalai
            {view.repo !== '' && <span className="ml-4 text-ash/70">{view.repo}</span>}
            {view.issue !== 0 && <span className="ml-3 text-ash/70">issue {view.issue}</span>}
          </span>
          <h1 className="max-w-[24ch] text-[1.6em] leading-tight">
            {view.title === '' ? 'Waiting for work' : view.title}
          </h1>
        </div>
        <button
          type="button"
          onClick={toggleDemo}
          className="shrink-0 rounded-full border border-hairline px-5 py-2 font-mono text-[0.6em] uppercase tracking-[0.2em] text-ash transition-colors hover:border-iris hover:text-bone"
        >
          {demo ? 'recorded run' : 'live'}
          <span
            className={
              status === 'live' && !demo
                ? 'ml-3 text-iris'
                : status === 'offline'
                  ? 'ml-3 text-spark'
                  : 'ml-3 text-ash/50'
            }
          >
            {status === 'live' ? 'connected' : status}
          </span>
        </button>
      </header>

      <StationLine view={view} />

      <section className="grid min-h-0 flex-1 grid-cols-1 gap-16 overflow-hidden lg:grid-cols-[1.1fr_0.9fr] [&>*]:min-w-0 [&>*]:min-h-0 [&>*]:overflow-y-auto">
        <CriteriaPanel view={view} />
        <ActivityPanel view={view} />
      </section>

      <footer className="shrink-0">
        <Outcome view={view} />
      </footer>
    </main>
  )
}
