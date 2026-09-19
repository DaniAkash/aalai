import { useRunData } from '@/screens/run/run.data'
import {
  ActivityPanel,
  CriteriaPanel,
  Outcome,
  StationLine,
} from '@/screens/run/run.components'

export function RunScreen() {
  const { view, replaying, restart } = useRunData()

  return (
    <main className="stage flex min-h-svh flex-col gap-12 bg-void px-[4vw] py-[5vh] text-bone">
      <header className="flex items-baseline justify-between gap-8">
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
        {!replaying && (
          <button
            type="button"
            onClick={restart}
            className="rounded-full border border-hairline px-5 py-2 font-mono text-[0.6em] uppercase tracking-[0.2em] text-ash transition-colors hover:border-iris hover:text-bone"
          >
            replay
          </button>
        )}
      </header>

      <StationLine view={view} />

      <section className="grid flex-1 grid-cols-1 gap-16 lg:grid-cols-[1.1fr_0.9fr]">
        <CriteriaPanel view={view} />
        <ActivityPanel view={view} />
      </section>

      <footer>
        <Outcome view={view} />
      </footer>
    </main>
  )
}
