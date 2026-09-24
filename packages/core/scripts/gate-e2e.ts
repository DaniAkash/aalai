/**
 * The human gate, end to end, the way a person actually uses it.
 *
 * Not a test file: it drives the real CLI as a subprocess, which is the part
 * the unit tests deliberately do not cover. Run from `packages/core` with
 * `bun run scripts/gate-e2e.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/modules/db/db'
import {
  listGates,
  openGate,
  readGate,
  supersedeOpenGates,
} from '@/modules/gates'
import { writeArtifact } from '@/modules/work/artifacts'

const dir = mkdtempSync(join(tmpdir(), 'aalai-e2e-'))
const env = { ...process.env, AALAI_STATE_DIR: dir, AALAI_NO_SERVER: '1' }
let failures = 0

const ESCAPE = String.fromCharCode(27)
const COLOUR = new RegExp(`${ESCAPE}\\[[0-9;]*m`, 'g')

function check(name: string, passed: boolean): void {
  process.stdout.write(`${passed ? '  PASS  ' : '  FAIL  '}${name}\n`)
  if (!passed) {
    failures += 1
  }
}

function scenario(name: string): void {
  process.stdout.write(`\n${name}\n`)
}

async function cli(args: string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return {
    out: `${stdout}${stderr}`.replace(COLOUR, ''),
    code: await proc.exited,
  }
}

process.env.AALAI_STATE_DIR = dir
const { sqlite } = openDb(join(dir, 'aalai.sqlite'))
const SUBJECT = { repo: 'acme/widgets', kind: 'issue' as const, number: 7 }
const RUN = 'acme/widgets#7@1790000000000'

scenario('1. An empty inbox reads as calm, not broken')
{
  const { out, code } = await cli(['gates'])
  check('exits zero', code === 0)
  check('says nothing is waiting', out.includes('nothing is waiting on you'))
}

scenario('2. A parked run shows what it is asking, and for how long')
await writeArtifact(SUBJECT, 'plan', '# Plan\n\n1. Add the guard\n2. Test it\n')
const planGate = openGate(sqlite, {
  runId: RUN,
  kind: 'plan',
  artifactPath: 'acme__widgets/issue-7/artifacts/plan.v1.md',
  artifactVersion: '1',
})
{
  const { out } = await cli(['gates'])
  check('the gate is listed', out.includes(planGate))
  check('it says what it is asking', out.includes('approve the plan'))
  const shown = await cli(['show', planGate])
  check('the artifact is rendered', shown.out.includes('Add the guard'))
  check('the version is stamped', shown.out.includes('version 1'))
}

scenario('3. Approving from a terminal, with nothing else running')
{
  const { out, code } = await cli(['approve', planGate])
  check('exits zero', code === 0)
  check('confirms the decision', out.includes('approved'))
  check(
    'recorded as answered',
    readGate(sqlite, planGate)?.status === 'answered',
  )
  check(
    'recorded which surface answered',
    readGate(sqlite, planGate)?.answeredOn === 'cli',
  )
  const after = await cli(['gates'])
  check('the inbox is empty again', after.out.includes('nothing is waiting'))
}

scenario('4. A second answer is refused and the first still stands')
{
  const { out, code } = await cli([
    'reject',
    planGate,
    '--reason',
    'changed my mind',
  ])
  check('exits non-zero so a script can tell', code === 1)
  check('says it was already answered', out.includes('already answered'))
  check(
    'the first decision survives',
    readGate(sqlite, planGate)?.decision === 'approved',
  )
}

scenario('5. A plan rewritten under a gate retires the old question')
{
  const v1 = openGate(sqlite, {
    runId: 'r2#1@1',
    kind: 'plan',
    artifactVersion: '1',
  })
  const v2 = openGate(sqlite, {
    runId: 'r2#1@1',
    kind: 'plan',
    artifactVersion: '2',
  })
  supersedeOpenGates(sqlite, 'r2#1@1', 'plan', { except: v2 })
  check(
    'the old question is retired',
    readGate(sqlite, v1)?.status === 'superseded',
  )
  check('the current one still stands', readGate(sqlite, v2)?.status === 'open')
  const { out, code } = await cli(['approve', v1])
  check('answering the retired one is refused', code === 1)
  check('and says why', out.includes('the plan changed'))
  check('no decision landed on it', readGate(sqlite, v1)?.decision === null)
}

scenario('6. Two permission asks are two questions, not one')
{
  const a = openGate(sqlite, {
    runId: RUN,
    kind: 'permission',
    nonce: crypto.randomUUID(),
    summary: 'write src/index.ts',
  })
  const b = openGate(sqlite, {
    runId: RUN,
    kind: 'permission',
    nonce: crypto.randomUUID(),
    summary: 'delete build/',
  })
  check('they are distinct questions', a !== b)
  const { out } = await cli(['gates'])
  check(
    'both are listed with what they ask',
    out.includes('write src/index.ts') && out.includes('delete build/'),
  )
  await cli(['approve', a])
  check(
    'answering one leaves the other open',
    readGate(sqlite, b)?.status === 'open',
  )
  check('and undecided', readGate(sqlite, b)?.decision === null)
}

scenario('7. Oldest first, because that is what an inbox is for')
{
  const rows = listGates(sqlite, { status: 'open' })
  const ordered = [...rows].sort((x, y) => x.openedAt.localeCompare(y.openedAt))
  check(
    'the list is oldest first',
    rows.map((r) => r.id).join() === ordered.map((r) => r.id).join(),
  )
}

sqlite.close()
rmSync(dir, { recursive: true, force: true })
process.stdout.write(
  `\n${failures === 0 ? 'all scenarios passed' : `${failures} checks failed`}\n`,
)
process.exit(failures === 0 ? 0 : 1)
