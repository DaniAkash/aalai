await import('@/run/pipeline')
const { createActor, fromPromise, waitFor } = await import('xstate')
const { prReview } = await import('@/run/machines/prReview')
const { provideRunDeps } = await import('@/run/machines/deps')
const { openDb } = await import('@/modules/db/db')
const { loadConfig } = await import('@/config')

const repo = 'DaniAkash/aalai-demo'
const prNumber = Number(process.argv[2] ?? '64')
/**
 * A clone of the repository under review.
 *
 * Passed in rather than written down, because where somebody keeps their
 * checkouts is theirs and an absolute path with a name in it has no business in
 * a repository.
 */
const clonePath = process.env.AALAI_DEMO_CLONE ?? ''
if (clonePath === '') {
  process.stdout.write(
    'set AALAI_DEMO_CLONE to a clone of the repository under review\n',
  )
  process.exit(1)
}
const state = process.env.AALAI_STATE_DIR ?? '/tmp'
const h = openDb(`${state}/aalai.sqlite`)
const run = {
  subject: { repo, kind: 'pr' as const, number: prNumber },
  runId: 'review-e2e',
}
const config = await loadConfig()
provideRunDeps('review-e2e', {
  db: h.sqlite,
  run,
  repo,
  config,
  issue: { number: prNumber, title: 'a contribution' },
  // A real clone, because the dynamic half needs somewhere to add a worktree.
  // The review itself still reads from `state`, which holds nothing.
  workspace: {
    worktreePath: state,
    clonePath,
    branch: 'main',
    base: 'main',
  },
  conventionFiles: [],
} as never)

const actor = createActor(
  prReview.provide({ actors: { staticReviewer: fromPromise(async () => {}) } }),
  {
    input: {
      runId: 'review-e2e',
      repo,
      prNumber,
      title: 'fix: capitalise only the first letter of each word',
      gatePollMs: 200,
    },
  },
).start()
const visited: string[] = []
actor.subscribe((s) => {
  const v = String(s.value)
  if (visited[visited.length - 1] !== v) visited.push(v)
})
try {
  await waitFor(
    actor,
    (s) => s.context.gateId !== undefined || s.status === 'done',
    { timeout: 60_000 },
  )
} catch (e) {
  process.stdout.write(
    `WAIT FAILED: ${e instanceof Error ? e.message : String(e)}\n`,
  )
}
// S1's actual claim, checked rather than reasoned about: the change being
// reviewed is not on disk in the place the review reads from. The diff reached
// the station as text in a prompt, and text cannot be executed.
const onDisk = await Bun.file(`${state}/src/titlecase.ts`)
  .text()
  .catch(() => '')
process.stdout.write(
  `CONTRIBUTOR_CODE_ON_DISK=${onDisk.includes('toLowerCase') ? 'yes' : 'no'}\n`,
)
const entries = [
  ...new Bun.Glob('**/*').scanSync({ cwd: state, onlyFiles: true }),
]
process.stdout.write(
  `FILES_IN_REVIEW_WORKTREE=${entries.filter((f) => !f.endsWith('.sqlite') && !f.includes('aalai.sqlite')).length}\n`,
)

const c = actor.getSnapshot().context
process.stdout.write(`STATES=${visited.join(' -> ')}\n`)
process.stdout.write(`HEAD=${c.headSha.slice(0, 7)}\n`)
process.stdout.write(`Q2=${JSON.stringify(c.execution)}\n`)
process.stdout.write(
  `GATES=${JSON.stringify(h.sqlite.query('select id,kind,status from gates').all())}\n`,
)
process.stdout.write(`TESTS=${JSON.stringify(c.tests ?? null)}\n`)
process.stdout.write(`OUTCOME=${JSON.stringify(c.outcome ?? null)}\n`)
actor.stop()
h.sqlite.close()
process.exit(0)
