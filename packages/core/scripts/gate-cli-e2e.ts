/**
 * The conversation held entirely from a terminal, with no server and no window.
 *
 * The proof that the gate belongs to the run rather than to an app. If the
 * discussion cannot be held here then it was built in the wrong place, whatever
 * the interface looks like.
 *
 * Run from `packages/core` with `bun run scripts/gate-cli-e2e.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { check, finish, scenario } from './e2e-report'

const dir = mkdtempSync(join(tmpdir(), 'aalai-cli-e2e-'))
const env = { ...process.env, AALAI_STATE_DIR: dir, AALAI_NO_SERVER: '1' }

process.env.AALAI_STATE_DIR = dir
const { openDb } = await import('@/modules/db/db')
const { openGate } = await import('@/modules/gates')
const { writeArtifact } = await import('@/modules/work/artifacts')

const { sqlite } = openDb(join(dir, 'aalai.sqlite'))
const subject = { repo: 'acme/widgets', kind: 'issue' as const, number: 44 }
const RUN = 'acme/widgets#44@1790000000044'
const artifact = await writeArtifact(
  subject,
  'plan',
  '# Plan\n\n1. Stream it\n',
)
const gateId = openGate(sqlite, {
  runId: RUN,
  kind: 'plan',
  artifactPath: artifact.id,
  artifactVersion: String(artifact.version),
})
sqlite.close()

async function cli(...args: string[]): Promise<string> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  await proc.exited
  return out + err
}

scenario('The discussion, held from a terminal with nothing running')

const empty = await cli('thread', gateId)
check('an untouched thread says so', empty.includes('nothing said yet'))

const replied = await cli('reply', gateId, 'Why stream rather than buffer?')
check('the reply was recorded', replied.includes('said'))
check('and it says the gate is still open', replied.includes('still open'))

const after = await cli('thread', gateId)
check(
  'the thread shows it back',
  after.includes('Why stream rather than buffer?'),
)
check('attributed to a maintainer', after.includes('maintainer'))

const badGate = await cli('reply', 'no-such-gate', 'hello')
check('an unknown gate is refused', badGate.includes('no such gate'))

const noArgs = await cli('reply', gateId)
check('a reply with nothing to say shows usage', noArgs.includes('usage'))

// Approving closes it, and a reply afterwards must be refused rather than appended.
await cli('approve', gateId)
const late = await cli('reply', gateId, 'too late')
check('a reply after the answer is refused', late.includes('no longer open'))

const stillThere = await cli('thread', gateId)
check('and the late reply was not appended', !stillThere.includes('too late'))

scenario('Two questions asked before either is answered keep their order')
{
  const { openGate } = await import('@/modules/gates')
  const { openDb: open2 } = await import('@/modules/db/db')
  const { sqlite: db2 } = open2()
  const s2 = { repo: 'acme/widgets', kind: 'issue' as const, number: 45 }
  const run2 = 'acme/widgets#45@1790000000045'
  const a2 = await writeArtifact(s2, 'plan', '# Plan\n\n1. One\n')
  const g2 = openGate(db2, {
    runId: run2,
    kind: 'plan',
    artifactPath: a2.id,
    artifactVersion: String(a2.version),
  })
  db2.close()

  await cli('reply', g2, 'the first thing I asked')
  await cli('reply', g2, 'the second thing I asked')
  const thread = await cli('thread', g2)
  const first = thread.indexOf('the first thing I asked')
  const second = thread.indexOf('the second thing I asked')
  check('both questions are in the record', first !== -1 && second !== -1)
  check('and in the order they were asked', first < second)
}

scenario('A triage gate is answerable and discussable from a terminal')
{
  const { openGate, readGate } = await import('@/modules/gates')
  const { openDb: openAgain } = await import('@/modules/db/db')
  const { sqlite: db3 } = openAgain()
  const s3 = { repo: 'acme/widgets', kind: 'issue' as const, number: 77 }
  const run3 = 'acme/widgets#77@1790000000077'
  const report = await writeArtifact(
    s3,
    'triage',
    '# Triage of #77\n\n**Classification:** duplicate\n**Confidence:** low\n',
  )
  const g3 = openGate(db3, {
    runId: run3,
    kind: 'triage',
    artifactPath: report.id,
    artifactVersion: String(report.version),
  })

  const listed = await cli('gates')
  check('a triage gate appears in the inbox', listed.includes(g3))
  check(
    'and says what it is asking, in words',
    listed.includes('is this worth doing'),
  )

  const shown = await cli('show', g3)
  check('the report is rendered', shown.includes('duplicate'))

  const said = await cli('reply', g3, 'are you sure? #12 looks different')
  check('a triage gate takes a reply', said.includes('said'))
  const thread = await cli('thread', g3)
  check('and the thread shows it back', thread.includes('#12 looks different'))

  const corrected = await cli(
    'reclassify',
    g3,
    '--reason',
    'this is a question, not a duplicate',
  )
  check('it can be reclassified', corrected.includes('reclassify'))
  const after = readGate(db3, g3)
  check(
    'which is recorded as its own decision',
    after?.decision === 'reclassify',
  )
  check(
    'carrying the correction',
    (after?.reason ?? '').includes('not a duplicate'),
  )
  db3.close()
}

scenario('A delivery that fails loses nothing')
{
  const { openGate, answerGate } = await import('@/modules/gates')
  const { openDb: openOnce } = await import('@/modules/db/db')
  const { queueOutbound, readQueued, readDelivery } = await import(
    '@/modules/work/store'
  )
  const { deliverOutbox } = await import('@/modules/outbound/deliver')
  const { sqlite: db4 } = openOnce()
  const s4 = { repo: 'acme/widgets', kind: 'issue' as const, number: 88 }
  const run4 = { subject: s4, runId: 'acme/widgets#88@1790000000088' }

  const g4 = openGate(db4, {
    runId: run4.runId,
    kind: 'triage',
    artifactVersion: '1',
  })
  answerGate(db4, {
    gateId: g4,
    decision: 'approved',
    answeredBy: 'dani',
    answeredOn: 'cli',
  })
  await queueOutbound(run4, {
    kind: 'comment_on_issue',
    body: 'this should survive a failed send',
    station: 'classifier',
    queuedAt: new Date().toISOString(),
    gateId: g4,
  })
  const queuedId = (await readQueued(run4))[0]?.id ?? ''

  // The token is wrong, so the post fails the way a revoked one would.
  const realToken = process.env.GH_TOKEN
  const realGhToken = process.env.GITHUB_TOKEN
  process.env.GH_TOKEN = 'not-a-token'
  process.env.GITHUB_TOKEN = 'not-a-token'
  const report = await deliverOutbox({
    db: db4,
    run: run4,
    repo: s4.repo,
    issueNumber: s4.number,
  })
  if (realToken === undefined) {
    delete process.env.GH_TOKEN
  } else {
    process.env.GH_TOKEN = realToken
  }
  if (realGhToken === undefined) {
    delete process.env.GITHUB_TOKEN
  } else {
    process.env.GITHUB_TOKEN = realGhToken
  }

  check('nothing is reported as sent', report.delivered.length === 0)
  check('and the failure is reported as one', report.failed.length === 1)
  check(
    'the intent is still queued, not dropped',
    (await readQueued(run4)).length === 1,
  )
  check(
    'and nothing claims it was delivered',
    (await readDelivery(run4, queuedId)) === undefined,
  )
  const stillAnswered = (await import('@/modules/gates')).readGate(db4, g4)
  check(
    'the answer stands: a failed send does not un-approve it',
    stillAnswered?.decision === 'approved',
  )
  db4.close()
}

rmSync(dir, { recursive: true, force: true })
finish()
