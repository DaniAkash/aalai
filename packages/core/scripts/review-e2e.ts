/**
 * A review of a real pull request, entered the way production enters it.
 *
 * Through discovery rather than by handing the machine a workspace, because the
 * first version of this did the latter and so proved a path that could not
 * happen: discovery passed the literal `HEAD` as a branch name and every review
 * failed before it started. An end to end test that supplies what the real entry
 * point would have produced is a test of what it supplied.
 *
 * Run from `packages/core`, with a repository to look at:
 *
 *   AALAI_DEMO_REPO=owner/name bun run scripts/review-e2e.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = process.env.AALAI_DEMO_REPO ?? ''
if (repo === '') {
  process.stdout.write('set AALAI_DEMO_REPO to owner/name\n')
  process.exit(1)
}
process.env.AALAI_STATE_DIR ??= mkdtempSync(join(tmpdir(), 'aalai-review-e2e-'))
process.env.AALAI_NO_SERVER = '1'

await import('@/run/pipeline')
const { openDb } = await import('@/modules/db/db')
const { loadConfig } = await import('@/config')
const { reviewOpenPullRequests } = await import('@/watch/reviews')

const h = openDb(join(process.env.AALAI_STATE_DIR, 'aalai.sqlite'))
const base = await loadConfig()
// Two passes over the same pull requests. Strict is the default and holds
// everything for a person, which is safe and exercises none of the running half,
// so the second pass is a repository that has said write access is its trust
// boundary. Without both, the path that actually runs somebody's tests has no
// coverage at all, which is how it lost coverage when signatures became
// required.
const strict = process.env.AALAI_DEMO_SIGNED !== 'waived'
const config = {
  ...base,
  requireSignedCommits: strict,
  watch: [{ repo, requireSignedCommits: strict }],
}
process.stdout.write(`REQUIRE_SIGNED=${strict}
`)

// Exactly what the poller calls, including the claim and the screen.
const started = reviewOpenPullRequests(h.sqlite, config as never)
process.stdout.write(`STARTED=${started}\n`)

// Long enough for discovery to claim, read and reach a decision or a gate.
await new Promise((resolve) => setTimeout(resolve, 90_000))

const runs = h.sqlite
  .query(
    'select subject_number, status, error from runs where subject_kind = ?',
  )
  .all('pr') as {
  subject_number: number
  status: string
  error: string | null
}[]
for (const row of runs) {
  process.stdout.write(
    `RUN pr=${row.subject_number} status=${row.status}${row.error === null ? '' : ` error=${row.error}`}\n`,
  )
}
const gates = h.sqlite
  .query('select id, kind, status, summary from gates')
  .all() as { id: string; kind: string; status: string }[]
process.stdout.write(`GATES=${JSON.stringify(gates)}\n`)

h.sqlite.close()
process.exit(0)
