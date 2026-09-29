/**
 * Seeds a state directory with a plan gate mid discussion.
 *
 * For driving the interface in a browser: the screens need a gate that exists,
 * an artifact to read and a thread with something in it, and waiting for a real
 * agent run to reach that point is minutes of nothing to look at.
 *
 * Run from `packages/core` with `AALAI_STATE_DIR=<dir> bun run scripts/seed-gate-conversation.ts`.
 */
import { openDb } from '@/modules/db/db'
import { openGate } from '@/modules/gates'
import { writeArtifact } from '@/modules/work/artifacts'
import { appendEntry } from '@/modules/work/conversation'
import { demoSubject } from './demo-subject'

const { subject, runId } = demoSubject()

const { sqlite } = openDb()

const plan = `# Plan

## Problem
The importer drops rows whose timestamp is missing, silently, so a partial
import looks like a clean one.

## Approach
Stream the file and validate per row, collecting rejects into a report rather
than failing the whole batch.

## Steps
1. Read the file as a stream rather than into memory
2. Validate each row and collect the rejects
3. Report the rejected row numbers and a reason

## Acceptance criteria
1. A malformed row is skipped and counted, not dropped silently
2. The importer reports rejected row numbers and a reason
3. A file of 2GB imports without exceeding 300MB resident
`

const artifact = await writeArtifact(subject, 'plan', plan)
const gateId = openGate(sqlite, {
  runId,
  kind: 'plan',
  artifactPath: artifact.id,
  artifactVersion: String(artifact.version),
})

await appendEntry(subject, {
  author: 'analyst',
  role: 'station',
  body: 'Plan and acceptance criteria recorded.',
})

sqlite.close()
process.stdout.write(`${gateId}\n`)
