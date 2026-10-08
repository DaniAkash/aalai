/**
 * Seeds one subject with a thread worth looking at.
 *
 * The work detail screen merges three sources that are each written by a
 * different part of the system, and waiting for a real run to produce all of
 * them is minutes of nothing. This writes the shape they produce: a brief, two
 * plan versions with an argument between them, an approval, the stations
 * narrating, and a review at the end.
 *
 * Run from `packages/core` with
 * `AALAI_STATE_DIR=<dir> bun run scripts/seed-work-thread.ts`.
 */
import { rm } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { and, eq, like } from 'drizzle-orm'
import { openDb } from '@/modules/db/db'
import { query } from '@/modules/db/query'
import { gates, runs } from '@/modules/db/schema/schema'
import { answerGate, openGate } from '@/modules/gates'
import { blockRun, offerRun } from '@/modules/runs/queue'
import { writeArtifact } from '@/modules/work/artifacts'
import { appendEntry } from '@/modules/work/conversation'
import { type Subject, subjectDir } from '@/modules/work/paths'

/**
 * A gate decision the database rejects leaves the gate open and the thread
 * wrong, and `answerGate` reports that rather than throwing. A seed that
 * ignores the result produces data that looks fine and is not.
 */
function mustAnswer(result: { ok: boolean }, what: string): void {
  if (!result.ok) {
    throw new Error(
      `could not answer the ${what} gate: ${JSON.stringify(result)}`,
    )
  }
}

/**
 * Gate timestamps are second resolution, so two written in the same second
 * sort by id and the thread reads out of order. A real run has minutes
 * between these.
 */
const BEAT = 1100

const repo = process.env.SEED_REPO ?? 'DaniAkash/aalai-demo'
const number = Number(process.env.SEED_ISSUE ?? '61')
const subject: Subject = { repo, kind: 'issue', number }
const runId = `${repo}#${number}@1790000000061`
const title = 'formatBytes gives me the wrong number'

const { sqlite } = openDb()

/**
 * Clears the subject first, so running this twice gives the same thread.
 *
 * Artifacts are versioned and conversation entries append, so without this a
 * second run produces plan v4 and every line said twice, which is not a
 * scenario anybody would recognise.
 */
await rm(subjectDir(subject), { recursive: true, force: true })
query(sqlite)
  .delete(gates)
  .where(like(gates.runId, `${repo}#${number}@%`))
  .run()
query(sqlite)
  .delete(runs)
  .where(
    and(
      eq(runs.repo, repo),
      eq(runs.subjectKind, 'issue'),
      eq(runs.subjectNumber, number),
    ),
  )
  .run()

offerRun(sqlite, { repo, kind: 'issue', number, title })

await appendEntry(subject, {
  author: 'dani',
  role: 'maintainer',
  body: 'formatBytes(1024) returns "1024 B" when I expect "1 KB". It looks like the loop never divides, so anything under a megabyte is reported in bytes.',
})

const planV1 = `# Plan

## Problem
\`formatBytes\` compares against the wrong bound, so a value is only promoted to
the next unit once it is a full multiple of it rather than once it reaches it.

## Approach
Divide while the value is at or above the unit size, rather than above it.

## Steps
1. Correct the comparison in the unit loop
2. Round to one decimal place rather than truncating

## Acceptance criteria
1. formatBytes(1024) returns "1 KB"
2. formatBytes(1023) returns "1023 B"
3. Existing tests still pass
`

await sleep(BEAT)
const v1 = await writeArtifact(subject, 'plan', planV1)
const gate1 = openGate(sqlite, {
  runId,
  kind: 'plan',
  artifactPath: v1.id,
  artifactVersion: String(v1.version),
})

await appendEntry(subject, {
  author: 'analyst',
  role: 'station',
  body: 'Plan and acceptance criteria recorded. The rounding is a guess: the issue does not say what it expects for 1536.',
})

await appendEntry(subject, {
  author: 'dani',
  role: 'maintainer',
  body: 'Round to one decimal, so 1536 is "1.5 KB". Also do not print a decimal for whole numbers.',
})

mustAnswer(
  answerGate(sqlite, {
    gateId: gate1,
    decision: 'changes',
    answeredBy: 'dani',
    answeredOn: 'app',
    reason: 'Rounding needs to be specified.',
  }),
  'first plan',
)
await sleep(BEAT)

const planV2 = `${planV1}
## Revision
Round to one decimal place, and drop the decimal when it is zero, so 1024 is
"1 KB" and 1536 is "1.5 KB".

## Acceptance criteria
1. formatBytes(1024) returns "1 KB"
2. formatBytes(1536) returns "1.5 KB"
3. formatBytes(1023) returns "1023 B"
4. Existing tests still pass
`

await sleep(BEAT)
const v2 = await writeArtifact(subject, 'plan', planV2)
const gate2 = openGate(sqlite, {
  runId,
  kind: 'plan',
  artifactPath: v2.id,
  artifactVersion: String(v2.version),
})

mustAnswer(
  answerGate(sqlite, {
    gateId: gate2,
    decision: 'approved',
    answeredBy: 'dani',
    answeredOn: 'app',
  }),
  'second plan',
)
await sleep(BEAT)

await sleep(BEAT)
await appendEntry(subject, {
  author: 'implementer',
  role: 'station',
  body: 'Corrected the comparison and the rounding in src/bytes.ts. Four test files pass.',
})

await sleep(BEAT)
await writeArtifact(
  subject,
  'review',
  `# Review

## Verdict
approve

## Criteria
1. formatBytes(1024) returns "1 KB" — pass, covered by the new case
2. formatBytes(1536) returns "1.5 KB" — pass
3. formatBytes(1023) returns "1023 B" — pass
4. Existing tests still pass — pass, 68 files

## Summary
The change is one comparison and one rounding call. Nothing else reads the
unit table, so the surface is the function itself.
`,
)

await sleep(BEAT)

// Parked on a permission ask, so the screen has something open to answer.
blockRun(sqlite, repo, 'issue', number)
const open = openGate(sqlite, {
  runId,
  kind: 'permission',
  summary: 'Open a draft pull request against main',
  nonce: 'deliver',
})

sqlite.close()
process.stdout.write(`${repo}#${number} seeded, open gate ${open}\n`)
