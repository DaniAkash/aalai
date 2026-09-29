/**
 * Seeds a state directory with triage gates at different confidences.
 *
 * For driving the interface by hand: the screens need gates that exist and
 * reports to read, and waiting for a real classifier to reach that point is
 * minutes of nothing to look at.
 *
 * Run from `packages/core` with `AALAI_STATE_DIR=<dir> bun run scripts/seed-triage.ts`.
 */
import { openDb } from '@/modules/db/db'
import { openGate } from '@/modules/gates'
import { recordTriage } from '@/run/artifacts'
import { triageSchema } from '@/run/stations/schemas'
import { demoSubject } from './demo-subject'

const { repo, subject, runId } = demoSubject()
const { sqlite } = openDb()

const kind = process.env.SEED_KIND ?? 'bug'
const report = triageSchema.parse({
  classification: kind,
  confidence: process.env.SEED_CONFIDENCE ?? 'high',
  summary:
    kind === 'duplicate'
      ? 'this looks like the importer issue already reported'
      : kind === 'question'
        ? 'the reporter is asking how to configure the importer'
        : 'the importer drops rows whose timestamp is missing',
  reasoning:
    'The reporter names a version and gives a reproduction. The importer validates rows and discards the ones it cannot parse without counting them.',
  affected_surface: ['src/import.ts', 'test/import.test.ts'],
  missing:
    process.env.SEED_MISSING === '1' ? ['a reproduction', 'the version'] : [],
  ...(kind === 'duplicate' ? { duplicate_of: 12 } : {}),
  ...(kind === 'security'
    ? {}
    : { reply: 'Thanks for reporting this. Streaming the file avoids it.' }),
})

const artifact = await recordTriage(
  subject,
  { subject, runId },
  { number: subject.number, title: 'the importer drops rows' },
  report,
)
const gateId = openGate(sqlite, {
  runId,
  kind: 'triage',
  artifactPath: artifact.id,
  artifactVersion: String(artifact.version),
})
sqlite.close()
process.stdout.write(`${gateId}\n`)
void repo
