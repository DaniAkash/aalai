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

rmSync(dir, { recursive: true, force: true })
finish()
